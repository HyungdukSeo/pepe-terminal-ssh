import Foundation
import Capacitor

@objc(ClaudePlugin)
public class ClaudePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ClaudePlugin"
    public let jsName = "Claude"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setApiKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getApiKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "streamChat", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelRequest", returnType: CAPPluginReturnPromise),
    ]

    private static let apiKeyKey = "com.ghjeong.pepe.claude.apiKey"
    private var activeTasks: [String: URLSessionDataTask] = [:]
    private let lock = NSLock()

    @objc func setApiKey(_ call: CAPPluginCall) {
        guard let key = call.getString("apiKey") else {
            call.reject("apiKey required")
            return
        }
        UserDefaults.standard.set(key, forKey: Self.apiKeyKey)
        call.resolve(["ok": true])
    }

    @objc func getApiKey(_ call: CAPPluginCall) {
        let key = UserDefaults.standard.string(forKey: Self.apiKeyKey)
        call.resolve(["apiKey": key ?? "", "hasKey": key != nil && !(key!.isEmpty)])
    }

    @objc func streamChat(_ call: CAPPluginCall) {
        guard let body = call.getString("body") else {
            call.reject("body required")
            return
        }
        let requestId = call.getString("requestId") ?? UUID().uuidString

        guard let apiKey = UserDefaults.standard.string(forKey: Self.apiKeyKey),
              !apiKey.isEmpty else {
            call.reject("API key not configured")
            return
        }

        guard let url = URL(string: "https://api.anthropic.com/v1/messages") else {
            call.reject("invalid URL")
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
        request.httpBody = body.data(using: .utf8)

        let delegate = SSEDelegate(plugin: self, requestId: requestId)
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 300
        let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
        let task = session.dataTask(with: request)

        lock.lock()
        activeTasks[requestId] = task
        lock.unlock()

        task.resume()
        call.resolve(["requestId": requestId])
    }

    @objc func cancelRequest(_ call: CAPPluginCall) {
        let requestId = call.getString("requestId") ?? ""
        lock.lock()
        let task = activeTasks.removeValue(forKey: requestId)
        lock.unlock()
        task?.cancel()
        call.resolve()
    }

    fileprivate func emit(_ requestId: String, _ data: [String: Any]) {
        var payload = data
        payload["requestId"] = requestId
        notifyListeners("stream", data: payload)
    }

    fileprivate func removeTask(_ requestId: String) {
        lock.lock()
        activeTasks.removeValue(forKey: requestId)
        lock.unlock()
    }
}

private class SSEDelegate: NSObject, URLSessionDataDelegate {
    weak var plugin: ClaudePlugin?
    let requestId: String
    private var buffer = ""
    private var httpStatus = 0
    private var errorBody = Data()

    init(plugin: ClaudePlugin, requestId: String) {
        self.plugin = plugin
        self.requestId = requestId
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        httpStatus = (response as? HTTPURLResponse)?.statusCode ?? 0
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        if httpStatus != 200 {
            errorBody.append(data)
            return
        }
        guard let chunk = String(data: data, encoding: .utf8) else { return }
        buffer += chunk

        while true {
            guard let range = buffer.range(of: "\n") else { break }
            let line = String(buffer[buffer.startIndex..<range.lowerBound])
                .trimmingCharacters(in: CharacterSet(charactersIn: "\r"))
            buffer = String(buffer[range.upperBound...])

            guard line.hasPrefix("data: ") else { continue }
            let jsonStr = String(line.dropFirst(6))
            guard let jsonData = jsonStr.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any] else { continue }
            plugin?.emit(requestId, ["type": "sse", "data": json])
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        defer {
            plugin?.emit(requestId, ["type": "done"])
            plugin?.removeTask(requestId)
            session.invalidateAndCancel()
        }

        if let error = error {
            if (error as NSError).code == NSURLErrorCancelled {
                plugin?.emit(requestId, ["type": "cancelled"])
            } else {
                plugin?.emit(requestId, ["type": "error", "error": error.localizedDescription])
            }
            return
        }

        if httpStatus != 200 {
            let body = String(data: errorBody, encoding: .utf8) ?? ""
            var msg = "HTTP \(httpStatus)"
            if let data = body.data(using: .utf8),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let errObj = json["error"] as? [String: Any],
               let errMsg = errObj["message"] as? String {
                msg = errMsg
            }
            plugin?.emit(requestId, ["type": "error", "error": msg])
        }
    }
}
