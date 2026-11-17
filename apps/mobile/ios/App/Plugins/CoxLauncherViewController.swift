import Capacitor

final class CoxLauncherViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(CoxWorkspaceWebViewPlugin())
        if let vaultClass = NSClassFromString("App.CoxVaultPlugin") as? CAPPlugin.Type
            ?? NSClassFromString("CoxVaultPlugin") as? CAPPlugin.Type {
            bridge?.registerPluginInstance(vaultClass.init())
        }
    }
}
