import UIKit
import Capacitor

@objc(MainViewController)
class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(SSHPlugin())
        bridge?.registerPluginInstance(SFTPPlugin())
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        // keybar 버튼 터치 시 키보드가 내려가지 않도록 설정
        webView?.scrollView.keyboardDismissMode = .none
    }
}
