import Foundation
import Capacitor
import NMSSH

@objc(SSHPlugin)
public class SSHPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SSHPlugin"
    public let jsName = "SSH"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resize", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isConnected", returnType: CAPPluginReturnPromise),
    ]

    private var connections: [String: SSHConnection] = [:]
    private let queue = DispatchQueue(label: "com.ghjeong.pepe.ssh.plugin", qos: .userInitiated)

    @objc func connect(_ call: CAPPluginCall) {
        guard let connectionId = call.getString("connectionId"),
              let host = call.getString("host"),
              let username = call.getString("username") else {
            call.reject("connectionId, host, username are required")
            return
        }
        let port = call.getInt("port") ?? 22
        let password = call.getString("password")
        let privateKey = call.getString("privateKey")
        let passphrase = call.getString("passphrase")
        let cols = call.getInt("cols") ?? 80
        let rows = call.getInt("rows") ?? 24

        queue.async { [weak self] in
            guard let self = self else { return }
            let conn = SSHConnection(connectionId: connectionId, plugin: self)
            let result = conn.connectAndStartShell(
                host: host, port: port, username: username,
                password: password, privateKey: privateKey, passphrase: passphrase,
                cols: cols, rows: rows
            )
            switch result {
            case .success:
                DispatchQueue.main.async {
                    self.connections[connectionId] = conn
                }
                self.notifyListeners("connected", data: ["connectionId": connectionId])
                call.resolve(["ok": true])
            case .failure(let err):
                call.reject(err.localizedDescription)
            }
        }
    }

    @objc func disconnect(_ call: CAPPluginCall) {
        guard let connectionId = call.getString("connectionId") else {
            call.reject("connectionId required")
            return
        }
        let conn = connections.removeValue(forKey: connectionId)
        queue.async {
            conn?.disconnect()
            call.resolve()
        }
    }

    @objc func write(_ call: CAPPluginCall) {
        guard let connectionId = call.getString("connectionId"),
              let data = call.getString("data") else {
            call.reject("connectionId and data required")
            return
        }
        guard let conn = connections[connectionId] else {
            call.reject("not connected")
            return
        }
        queue.async {
            conn.write(data)
            call.resolve()
        }
    }

    @objc func resize(_ call: CAPPluginCall) {
        guard let connectionId = call.getString("connectionId") else {
            call.reject("connectionId required")
            return
        }
        let cols = call.getInt("cols") ?? 80
        let rows = call.getInt("rows") ?? 24
        guard let conn = connections[connectionId] else {
            call.resolve()
            return
        }
        queue.async {
            conn.resize(cols: cols, rows: rows)
            call.resolve()
        }
    }

    @objc func isConnected(_ call: CAPPluginCall) {
        let connectionId = call.getString("connectionId") ?? ""
        let connected = connections[connectionId]?.isConnected ?? false
        call.resolve(["connected": connected])
    }

    // Called by SSHConnection on background thread
    func emitData(_ connectionId: String, _ data: String) {
        notifyListeners("data", data: ["connectionId": connectionId, "data": data])
    }
    func emitClosed(_ connectionId: String) {
        DispatchQueue.main.async { [weak self] in
            self?.connections.removeValue(forKey: connectionId)
        }
        notifyListeners("closed", data: ["connectionId": connectionId])
    }
    func emitError(_ connectionId: String, _ error: String) {
        notifyListeners("error", data: ["connectionId": connectionId, "error": error])
    }
}

class SSHConnection: NSObject, NMSSHSessionDelegate, NMSSHChannelDelegate {
    let connectionId: String
    weak var plugin: SSHPlugin?
    var session: NMSSHSession?
    var isConnected: Bool = false

    init(connectionId: String, plugin: SSHPlugin) {
        self.connectionId = connectionId
        self.plugin = plugin
    }

    enum ConnectError: Error, LocalizedError {
        case connectFailed
        case authFailed(String)
        case shellFailed(String)
        var errorDescription: String? {
            switch self {
            case .connectFailed: return "Failed to connect to host"
            case .authFailed(let m): return "Authentication failed: \(m)"
            case .shellFailed(let m): return "Failed to start shell: \(m)"
            }
        }
    }

    func connectAndStartShell(
        host: String, port: Int, username: String,
        password: String?, privateKey: String?, passphrase: String?,
        cols: Int, rows: Int
    ) -> Result<Void, Error> {
        let sess = NMSSHSession(host: host, port: port, andUsername: username)
        sess.delegate = self
        sess.connect()
        guard sess.isConnected else {
            return .failure(ConnectError.connectFailed)
        }

        if let pk = privateKey, !pk.isEmpty {
            sess.authenticate(byInMemoryPublicKey: nil, privateKey: pk, andPassword: passphrase)
        } else if let pw = password, !pw.isEmpty {
            sess.authenticate(byPassword: pw)
        } else {
            sess.authenticate(byPassword: "")
        }

        guard sess.isAuthorized else {
            sess.disconnect()
            return .failure(ConnectError.authFailed("invalid credentials"))
        }

        sess.channel.delegate = self
        sess.channel.requestPty = true
        sess.channel.ptyTerminalType = NMSSHChannelPtyTerminal.xterm
        sess.channel.requestSizeWidth(UInt(cols), height: UInt(rows))

        var startError: NSError?
        do {
            try sess.channel.startShell()
        } catch let err as NSError {
            startError = err
        }
        if let err = startError {
            sess.disconnect()
            return .failure(ConnectError.shellFailed(err.localizedDescription))
        }

        self.session = sess
        self.isConnected = true
        return .success(())
    }

    func write(_ data: String) {
        guard let sess = session, sess.isConnected else { return }
        do {
            try sess.channel.write(data, timeout: 5)
        } catch let err as NSError {
            plugin?.emitError(connectionId, "write failed: \(err.localizedDescription)")
        }
    }

    func resize(cols: Int, rows: Int) {
        guard let sess = session, sess.isConnected else { return }
        sess.channel.requestSizeWidth(UInt(cols), height: UInt(rows))
    }

    func disconnect() {
        isConnected = false
        if let sess = session {
            sess.channel.closeShell()
            sess.disconnect()
        }
        session = nil
    }

    // MARK: NMSSHChannelDelegate
    func channel(_ channel: NMSSHChannel, didReadData message: String) {
        plugin?.emitData(connectionId, message)
    }

    func channel(_ channel: NMSSHChannel, didReadError error: String) {
        plugin?.emitData(connectionId, error)
    }

    func channelShellDidClose(_ channel: NMSSHChannel) {
        isConnected = false
        plugin?.emitClosed(connectionId)
    }
}
