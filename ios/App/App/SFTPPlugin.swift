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
    ]

    private var sessions: [String: NMSSHSession] = [:]
    private var autoTrackTimers: [String: DispatchSourceTimer] = [:]
    private var autoTrackScripts: [String: String] = [:]
    private var lastCwd: [String: String] = [:]
    private let queue = DispatchQueue(label: "com.ghjeong.pepe.sftp.plugin", qos: .userInitiated)

    /// ps + readlink → 사용자 interactive 셸의 cwd. base64 wrap 으로 quoting 회피.
    /// - sshdPid 가 주어지면 ppid 매칭으로 *이* SSH 세션의 셸만 식별 (멀티세션 격리).
    /// - 없으면 fallback: TTY 있는 셸 중 largest PID (단일 세션 환경).
    private static func buildScript(sshdPid: Int?) -> String {
        let filter: String
        if let pid = sshdPid {
            filter = "$2 == \(pid) && $4 ~ /^-?(bash|zsh|sh|ksh|dash|fish|csh|tcsh)$/ && $3 != \"?\""
        } else {
            filter = "$4 ~ /^-?(bash|zsh|sh|ksh|dash|fish|csh|tcsh)$/ && $3 != \"?\""
        }
        let script = """
        p=$(ps -u "$(whoami)" -o pid,ppid,tty,comm 2>/dev/null | awk '\(filter) {print $1}' | sort -nr | head -1)
        test -n "$p" && printf 'PEPECWD<%s>END' "$(readlink /proc/$p/cwd 2>/dev/null)"
        """
        return Data(script.utf8).base64EncodedString()
    }

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
        autoTrackTimers.removeValue(forKey: connectionId)?.cancel()
        autoTrackScripts.removeValue(forKey: connectionId)
        lastCwd.removeValue(forKey: connectionId)
        queue.async {
            sess?.sftp.disconnect()
            sess?.disconnect()
            call.resolve()
        }
    }

    @objc func setAutoTrack(_ call: CAPPluginCall) {
        guard let connectionId = call.getString("connectionId") else {
            call.reject("connectionId required")
            return
        }
        let enabled = call.getBool("enabled") ?? false
        let sshdPid = call.getInt("sshdPid")  // optional — 더 정확한 필터링용

        // 기존 타이머 정리
        autoTrackTimers.removeValue(forKey: connectionId)?.cancel()
        autoTrackScripts.removeValue(forKey: connectionId)
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

        // sshdPid 가 있으면 정확한 ppid 매칭, 없으면 fallback (largest PID with TTY)
        autoTrackScripts[connectionId] = SFTPPlugin.buildScript(sshdPid: sshdPid)

        // 폴링 타이머 시작 (400ms 주기)
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + .milliseconds(200), repeating: .milliseconds(400))
        timer.setEventHandler { [weak self] in
            self?.pollCwd(for: connectionId)
        }
        autoTrackTimers[connectionId] = timer
        timer.resume()
        notifyListeners("autoTrackChanged", data: ["connectionId": connectionId, "enabled": true])
        call.resolve(["enabled": true])
    }

    private func pollCwd(for connectionId: String) {
        guard let sess = sessions[connectionId], sess.isConnected,
              let scriptB64 = autoTrackScripts[connectionId] else {
            autoTrackTimers.removeValue(forKey: connectionId)?.cancel()
            return
        }
        let cmd = "echo \(scriptB64) | base64 -d | /bin/sh"
        var err: NSError?
        guard let out = sess.channel.execute(cmd, error: &err, timeout: 3) else { return }
        // 'PEPECWD<...>END' 패턴 추출
        guard let startRange = out.range(of: "PEPECWD<"),
              let endRange = out.range(of: ">END", range: startRange.upperBound..<out.endIndex) else {
            return
        }
        let path = String(out[startRange.upperBound..<endRange.lowerBound])
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty, path.hasPrefix("/") else { return }
        if path == lastCwd[connectionId] { return }
        lastCwd[connectionId] = path
        notifyListeners("cwdChanged", data: ["connectionId": connectionId, "path": path])
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
            guard let items = sess.sftp.contentsOfDirectory(atPath: path) else {
                let err = sess.lastError?.localizedDescription ?? "directory listing returned nil"
                call.reject("listDir failed for '\(path)': \(err)")
                return
            }
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
        guard let sess = session(for: call) else { return }
        let path = call.getString("path") ?? "."
        queue.async {
            // For "." or "~" or empty — resolve to user's home via exec channel.
            // The SFTP session's NMSSHChannel is unused (we only use .sftp), so
            // it's safe to run a one-shot exec on it.
            if path == "." || path == "~" || path.isEmpty {
                var err: NSError?
                if let raw = sess.channel.execute("pwd 2>/dev/null", error: &err, timeout: 3) {
                    let resolved = raw.trimmingCharacters(in: .whitespacesAndNewlines)
                    if resolved.hasPrefix("/") {
                        call.resolve(["path": resolved])
                        return
                    }
                }
            }
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
}
