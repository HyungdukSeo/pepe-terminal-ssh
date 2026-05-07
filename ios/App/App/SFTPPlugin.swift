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
        CAPPluginMethod(name: "setAutoTrack", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exec", returnType: CAPPluginReturnPromise),
    ]

    private struct ConnParams {
        let host: String
        let port: Int
        let username: String
        let password: String?
        let privateKey: String?
        let passphrase: String?
    }

    private var sessions: [String: NMSSHSession] = [:]
    private var connParams: [String: ConnParams] = [:]
    private var execSessions: [String: NMSSHSession] = [:]
    private var autoTrackTimers: [String: DispatchSourceTimer] = [:]
    private var autoTrackPids: [String: Int] = [:]
    private var lastCwd: [String: String] = [:]
    private let queue = DispatchQueue(label: "com.ghjeong.pepe.sftp.plugin", qos: .userInitiated)
    private let execQueue = DispatchQueue(label: "com.ghjeong.pepe.sftp.exec", qos: .userInitiated)

    // MARK: - Auth helper

    private func authenticateSession(_ sess: NMSSHSession, password: String?, privateKey: String?, passphrase: String?) {
        if let pk = privateKey, !pk.isEmpty {
            sess.authenticate(byPublicKey: "", privateKey: pk, andPassword: passphrase ?? "")
        } else if let pw = password, !pw.isEmpty {
            sess.authenticate(byPassword: pw)
        } else {
            sess.authenticate(byPassword: "")
        }
    }

    // MARK: - Exec helpers

    private func ensureExecSession(for connectionId: String) -> NMSSHSession? {
        if let exec = execSessions[connectionId], exec.isConnected { return exec }
        guard let p = connParams[connectionId] else { return nil }
        let sess = NMSSHSession(host: p.host, port: p.port, andUsername: p.username)
        sess.connect()
        guard sess.isConnected else { return nil }
        authenticateSession(sess, password: p.password, privateKey: p.privateKey, passphrase: p.passphrase)
        guard sess.isAuthorized else { sess.disconnect(); return nil }
        execSessions[connectionId] = sess
        return sess
    }

    private func runScript(_ script: String, on exec: NMSSHSession, timeout: NSNumber = 5) -> String? {
        let b64 = Data(script.utf8).base64EncodedString()
        let cmd = "echo '\(b64)' | base64 -d | /bin/sh"
        let ch = NMSSHChannel(session: exec)
        var err: NSError?
        return ch.execute(cmd, error: &err, timeout: timeout)
    }

    private func extractMarker(from raw: String) -> String? {
        guard let s = raw.range(of: "<<PEPE>>"),
              let e = raw.range(of: "<<END>>", range: s.upperBound..<raw.endIndex) else { return nil }
        let v = String(raw[s.upperBound..<e.lowerBound])
        return v.isEmpty ? nil : v
    }

    // MARK: - /proc scanning for shell PID

    private func detectShellPid(exec: NMSSHSession) -> Int? {
        let script = """
        best=0
        for d in /proc/[0-9]*/; do
          pid="${d#/proc/}"
          pid="${pid%/}"
          [ -r "$d/environ" ] || continue
          env="$(cat "$d/environ" 2>/dev/null | tr '\\0' '\\n')"
          printf '%s\\n' "$env" | grep -q '^SSH_CONNECTION=' || continue
          printf '%s\\n' "$env" | grep -q '^TERM=' || continue
          tty="$(awk '{print $7}' "$d/stat" 2>/dev/null)"
          [ "$tty" != "0" ] || continue
          comm="$(cat "$d/comm" 2>/dev/null)"
          case "$comm" in
            bash|sh|zsh|tcsh|csh|fish|dash|ksh|ash) ;;
            *) continue ;;
          esac
          [ "$pid" -gt "$best" ] && best="$pid"
        done
        printf '<<PEPE>>%s<<END>>' "$best"
        """
        guard let raw = runScript(script, on: exec, timeout: 10),
              let val = extractMarker(from: raw),
              let pid = Int(val), pid > 0 else { return nil }
        return pid
    }

    // MARK: - Connect / Disconnect

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
            self.authenticateSession(sess, password: password, privateKey: privateKey, passphrase: passphrase)
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
                self.connParams[connectionId] = ConnParams(
                    host: host, port: port, username: username,
                    password: password, privateKey: privateKey, passphrase: passphrase
                )
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
        let exec = execSessions.removeValue(forKey: connectionId)
        autoTrackTimers.removeValue(forKey: connectionId)?.cancel()
        autoTrackPids.removeValue(forKey: connectionId)
        lastCwd.removeValue(forKey: connectionId)
        connParams.removeValue(forKey: connectionId)
        queue.async {
            sess?.sftp.disconnect()
            sess?.disconnect()
        }
        execQueue.async {
            exec?.disconnect()
            call.resolve()
        }
    }

    // MARK: - Auto-track

    @objc func setAutoTrack(_ call: CAPPluginCall) {
        guard let connectionId = call.getString("connectionId") else {
            call.reject("connectionId required")
            return
        }
        let enabled = call.getBool("enabled") ?? false

        autoTrackTimers.removeValue(forKey: connectionId)?.cancel()
        autoTrackPids.removeValue(forKey: connectionId)
        lastCwd.removeValue(forKey: connectionId)

        if !enabled {
            notifyListeners("autoTrackChanged", data: ["connectionId": connectionId, "enabled": false])
            call.resolve(["enabled": false])
            return
        }

        guard sessions[connectionId] != nil else {
            call.reject("not connected")
            return
        }

        execQueue.async { [weak self] in
            guard let self = self else { return }
            guard let exec = self.ensureExecSession(for: connectionId) else {
                call.reject("failed to create exec session")
                return
            }
            guard let pid = self.detectShellPid(exec: exec) else {
                call.reject("failed to detect shell PID")
                return
            }
            self.autoTrackPids[connectionId] = pid

            let timer = DispatchSource.makeTimerSource(queue: self.execQueue)
            timer.schedule(deadline: .now() + .milliseconds(200), repeating: .milliseconds(400))
            timer.setEventHandler { [weak self] in
                self?.pollCwd(for: connectionId)
            }
            self.autoTrackTimers[connectionId] = timer
            timer.resume()
            self.notifyListeners("autoTrackChanged", data: ["connectionId": connectionId, "enabled": true])
            call.resolve(["enabled": true])
        }
    }

    private func pollCwd(for connectionId: String) {
        guard let exec = execSessions[connectionId],
              let pid = autoTrackPids[connectionId],
              autoTrackTimers[connectionId] != nil else {
            autoTrackTimers.removeValue(forKey: connectionId)?.cancel()
            return
        }
        let script = "printf '<<PEPE>>%s<<END>>' \"$(readlink /proc/\(pid)/cwd 2>/dev/null)\""
        guard let raw = runScript(script, on: exec, timeout: 3),
              let path = extractMarker(from: raw),
              path.hasPrefix("/") else {
            return
        }
        if path == lastCwd[connectionId] { return }
        lastCwd[connectionId] = path
        notifyListeners("cwdChanged", data: ["connectionId": connectionId, "path": path])
    }

    // MARK: - SFTP helpers

    private func session(for call: CAPPluginCall) -> NMSSHSession? {
        guard let connectionId = call.getString("connectionId"),
              let sess = sessions[connectionId],
              sess.sftp.isConnected else {
            call.reject("not connected")
            return nil
        }
        return sess
    }

    // MARK: - SFTP operations

    @objc func listDir(_ call: CAPPluginCall) {
        guard let sess = session(for: call) else { return }
        let path = call.getString("path") ?? "."
        queue.async {
            guard let items = sess.sftp.contentsOfDirectory(atPath: path) else {
                let err = sess.lastError?.localizedDescription ?? "directory listing returned nil"
                call.reject("listDir failed for '\(path)': \(err)")
                return
            }
            let entries: [[String: Any]] = items.map { item in
                let f = item
                return [
                    "name": f.filename,
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
        guard session(for: call) != nil else { return }
        let connectionId = call.getString("connectionId")!
        let path = call.getString("path") ?? "."
        if path == "." || path == "~" || path.isEmpty {
            execQueue.async { [weak self] in
                guard let self = self,
                      let exec = self.ensureExecSession(for: connectionId) else {
                    call.resolve(["path": path])
                    return
                }
                let script = "printf '<<PEPE>>%s<<END>>' \"$(pwd)\""
                if let raw = self.runScript(script, on: exec),
                   let resolved = self.extractMarker(from: raw),
                   resolved.hasPrefix("/") {
                    call.resolve(["path": resolved])
                } else {
                    call.resolve(["path": path])
                }
            }
        } else {
            call.resolve(["path": path])
        }
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

    @objc func exec(_ call: CAPPluginCall) {
        guard let connectionId = call.getString("connectionId"),
              let command = call.getString("command") else {
            call.reject("connectionId and command required")
            return
        }
        let timeout = NSNumber(value: call.getInt("timeout") ?? 120)
        execQueue.async { [weak self] in
            guard let self = self,
                  let exec = self.ensureExecSession(for: connectionId) else {
                call.reject("no exec session")
                return
            }
            let ch = NMSSHChannel(session: exec)
            var err: NSError?
            let result = ch.execute(command, error: &err, timeout: timeout)
            if let e = err {
                call.reject(e.localizedDescription)
            } else {
                call.resolve(["output": result ?? ""])
            }
        }
    }
}
