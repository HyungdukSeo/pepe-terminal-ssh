import Foundation
import Capacitor
import NMSSH

@objc(SFTPPlugin)
public class SFTPPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SFTPPlugin"
    public let jsName = "SFTP"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listDir", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "mkdir", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deletePath", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "rename", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "realPath", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeFile", returnType: CAPPluginReturnPromise),
    ]

    private var sessions: [String: NMSSHSession] = [:]
    private let queue = DispatchQueue(label: "com.ghjeong.pepe.sftp.plugin", qos: .userInitiated)

    @objc func connect(_ call: CAPPluginCall) {
        guard let connectionId = call.getString("connectionId"),
              let host = call.getString("host"),
              let username = call.getString("username") else {
            call.reject("connectionId, host, username required")
            return
        }
        let port = call.getInt("port") ?? 22
        let password = call.getString("password")
        let privateKey = call.getString("privateKey")
        let passphrase = call.getString("passphrase")

        queue.async { [weak self] in
            guard let self = self else { return }
            let sess = NMSSHSession(host: host, port: port, andUsername: username)
            sess.connect()
            guard sess.isConnected else {
                call.reject("Failed to connect to host")
                return
            }
            if let pk = privateKey, !pk.isEmpty {
                sess.authenticate(byPublicKey: "", privateKey: pk, andPassword: passphrase ?? "")
            } else if let pw = password, !pw.isEmpty {
                sess.authenticate(byPassword: pw)
            } else {
                sess.authenticate(byPassword: "")
            }
            guard sess.isAuthorized else {
                sess.disconnect()
                call.reject("SFTP authentication failed")
                return
            }
            sess.sftp.connect()
            guard sess.sftp.isConnected else {
                sess.disconnect()
                call.reject("Failed to open SFTP channel")
                return
            }
            DispatchQueue.main.async {
                self.sessions[connectionId] = sess
            }
            call.resolve(["ok": true])
        }
    }

    @objc func disconnect(_ call: CAPPluginCall) {
        guard let connectionId = call.getString("connectionId") else {
            call.resolve()
            return
        }
        let sess = sessions.removeValue(forKey: connectionId)
        queue.async {
            sess?.sftp.disconnect()
            sess?.disconnect()
            call.resolve()
        }
    }

    private func session(for call: CAPPluginCall) -> NMSSHSession? {
        guard let connectionId = call.getString("connectionId"),
              let sess = sessions[connectionId],
              sess.sftp.isConnected else {
            call.reject("not connected")
            return nil
        }
        return sess
    }

    @objc func listDir(_ call: CAPPluginCall) {
        guard let sess = session(for: call) else { return }
        let path = call.getString("path") ?? "."
        queue.async {
            let items = sess.sftp.contentsOfDirectory(atPath: path) ?? []
            let entries: [[String: Any]] = items.map { item in
                let f = item as! NMSFTPFile
                return [
                    "name": f.filename ?? "",
                    "isDirectory": f.isDirectory,
                    "size": f.fileSize?.uint64Value ?? 0,
                    "permissions": f.permissions ?? "",
                    "modifiedAt": (f.modificationDate?.timeIntervalSince1970 ?? 0) * 1000,
                ]
            }
            call.resolve(["files": entries])
        }
    }

    @objc func mkdir(_ call: CAPPluginCall) {
        guard let sess = session(for: call), let path = call.getString("path") else {
            call.reject("path required")
            return
        }
        queue.async {
            let ok = sess.sftp.createDirectory(atPath: path)
            if ok { call.resolve() } else { call.reject("mkdir failed") }
        }
    }

    @objc func deletePath(_ call: CAPPluginCall) {
        guard let sess = session(for: call), let path = call.getString("path") else {
            call.reject("path required")
            return
        }
        let isDir = call.getBool("isDirectory") ?? false
        queue.async {
            let ok = isDir ? sess.sftp.removeDirectory(atPath: path) : sess.sftp.removeFile(atPath: path)
            if ok { call.resolve() } else { call.reject("delete failed") }
        }
    }

    @objc func rename(_ call: CAPPluginCall) {
        guard let sess = session(for: call),
              let oldPath = call.getString("oldPath"),
              let newPath = call.getString("newPath") else {
            call.reject("oldPath/newPath required")
            return
        }
        queue.async {
            let ok = sess.sftp.moveItem(atPath: oldPath, toPath: newPath)
            if ok { call.resolve() } else { call.reject("rename failed") }
        }
    }

    @objc func realPath(_ call: CAPPluginCall) {
        // NMSFTP 2.3 doesn't expose libssh2_sftp_realpath. Return "/" so caller
        // can fall back to root, then navigate. Proper home-dir resolution is
        // a post-Phase-2 enhancement (likely via a parallel exec channel running pwd).
        _ = session(for: call)
        let path = call.getString("path") ?? "."
        let resolved = (path == "." || path == "~") ? "/" : path
        call.resolve(["path": resolved])
    }

    @objc func readFile(_ call: CAPPluginCall) {
        guard let sess = session(for: call), let path = call.getString("path") else {
            call.reject("path required")
            return
        }
        let encoding = call.getString("encoding") ?? "utf-8"
        queue.async {
            guard let data = sess.sftp.contents(atPath: path) else {
                call.reject("read failed")
                return
            }
            if encoding == "base64" {
                call.resolve(["content": data.base64EncodedString()])
            } else {
                let str = String(data: data, encoding: .utf8) ?? ""
                call.resolve(["content": str])
            }
        }
    }

    @objc func writeFile(_ call: CAPPluginCall) {
        guard let sess = session(for: call),
              let path = call.getString("path"),
              let content = call.getString("content") else {
            call.reject("path/content required")
            return
        }
        let encoding = call.getString("encoding") ?? "utf-8"
        queue.async {
            let data: Data?
            if encoding == "base64" {
                data = Data(base64Encoded: content)
            } else {
                data = content.data(using: .utf8)
            }
            guard let payload = data else {
                call.reject("invalid content encoding")
                return
            }
            let ok = sess.sftp.writeContents(payload, toFileAtPath: path)
            if ok { call.resolve() } else { call.reject("write failed") }
        }
    }
}
