import UIKit
import Capacitor

@objc(MainViewController)
class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(SSHPlugin())
        bridge?.registerPluginInstance(SFTPPlugin())
    }
}
