import Capacitor
import UIKit

final class CoxLauncherViewController: CAPBridgeViewController {
    private var statusBarFollowsSystem = true
    private var lightStatusContent = true

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(CoxWorkspaceWebViewPlugin())
        if let vaultClass = NSClassFromString("App.CoxVaultPlugin") as? CAPPlugin.Type
            ?? NSClassFromString("CoxVaultPlugin") as? CAPPlugin.Type {
            bridge?.registerPluginInstance(vaultClass.init())
        }
        publishSafeArea()
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        publishSafeArea()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        publishSafeArea()
    }

    func applyStatusBar(forHex color: String?) {
        if let color, let luminance = Self.relativeLuminance(hex: color) {
            statusBarFollowsSystem = false
            lightStatusContent = luminance < 0.5
        } else {
            statusBarFollowsSystem = true
            lightStatusContent = traitCollection.userInterfaceStyle == .dark
        }
        setNeedsStatusBarAppearanceUpdate()
    }

    override var preferredStatusBarStyle: UIStatusBarStyle {
        lightStatusContent ? .lightContent : .darkContent
    }

    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)
        if statusBarFollowsSystem {
            lightStatusContent = traitCollection.userInterfaceStyle == .dark
        }
        setNeedsStatusBarAppearanceUpdate()
    }

    private static func relativeLuminance(hex: String) -> Double? {
        let trimmed = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count == 7, trimmed.hasPrefix("#"),
              let value = Int(trimmed.dropFirst(), radix: 16) else { return nil }
        func channel(_ byte: Int) -> Double {
            let unit = Double(byte) / 255
            return unit <= 0.03928 ? unit / 12.92 : pow((unit + 0.055) / 1.055, 2.4)
        }
        let red = channel((value >> 16) & 0xff)
        let green = channel((value >> 8) & 0xff)
        let blue = channel(value & 0xff)
        return 0.2126 * red + 0.7152 * green + 0.0722 * blue
    }

    private func publishSafeArea() {
        let insets = view.safeAreaInsets
        let script = """
        (function(){
          var root = document.documentElement;
          if (!root) return;
          root.style.setProperty('--cox-safe-top','\(insets.top)px');
          root.style.setProperty('--cox-safe-right','\(insets.right)px');
          root.style.setProperty('--cox-safe-bottom','\(insets.bottom)px');
          root.style.setProperty('--cox-safe-left','\(insets.left)px');
        })();
        """
        bridge?.webView?.evaluateJavaScript(script, completionHandler: nil)
    }
}
