import OSLog
import Security
import UIKit
import WebKit

enum WorkspaceViewportLock {
    static let source = """
    (function(){
      var content = "width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content";
      var apply = function() {
        var head = document.head || document.documentElement;
        if (!head) return;
        var meta = document.querySelector('meta[name="viewport"]');
        if (!meta) {
          meta = document.createElement("meta");
          meta.setAttribute("name", "viewport");
          head.insertBefore(meta, head.firstChild);
        }
        if (meta.getAttribute("content") !== content) meta.setAttribute("content", content);
      };
      apply();
      document.addEventListener("DOMContentLoaded", apply);
    })();
    """
}

final class WorkspaceSession: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    let profile: WorkspaceProfile
    let webView: WKWebView
    var policy = WorkspacePolicy()
    var isActive = false
    weak var presenter: UIViewController?
    var onLauncher: ((String) -> Void)?
    var onLocation: ((String) -> Void)?
    let logger = Logger(subsystem: "dev.doublepi.cox.mobile", category: "workspace")
    let exports = WorkspaceExports()
    private var currentNavigation: WKNavigation?
    private var gatewayResponse = false
    private var disposed = false

    init(profile: WorkspaceProfile, configuration: WKWebViewConfiguration) {
        self.profile = profile
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        if profile.gatewayLogin { policy.detach(gateway: true) }
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.isInspectable = false
        webView.scrollView.minimumZoomScale = 1
        webView.scrollView.maximumZoomScale = 1
        webView.scrollView.bouncesZoom = false
        exports.profile = profile
        installViewportLock()
    }

    func installViewportLock() {
        let controller = webView.configuration.userContentController
        controller.addUserScript(WKUserScript(
            source: WorkspaceViewportLock.source,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        WorkspaceSafeAreaBootstrap.install(on: controller)
    }

    func detach(gateway: Bool) {
        policy.detach(gateway: gateway)
        clearBridge()
    }

    private func clearBridge() {
        let controller = webView.configuration.userContentController
        controller.removeScriptMessageHandler(forName: "coxMobileShell")
        controller.removeAllUserScripts()
        installViewportLock()
        webView.evaluateJavaScript(
            "delete window.__coxMobileShell__; window.dispatchEvent(new Event('cox:mobile-shell-change'));",
            completionHandler: nil
        )
    }

    func dispose() {
        disposed = true
        isActive = false
        detach(gateway: false)
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.removeFromSuperview()
        exports.dispose()
        currentNavigation = nil
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard !disposed, let url = action.request.url else {
            decisionHandler(.cancel)
            return
        }
        let main = action.targetFrame?.isMainFrame ?? true
        let gateway = profile.isGateway(url) || policy.phase == .gatewayHandoff
        if action.targetFrame == nil && !gateway {
            if profile.permitsTransport(url) && isActive { UIApplication.shared.open(url) }
            else { logger.warning("workspace.security_refusal reason=transport") }
            decisionHandler(.cancel)
            return
        }
        switch policy.navigate(url, profile: profile, main: main) {
        case .refuse:
            logger.warning("workspace.security_refusal reason=transport")
            decisionHandler(.cancel)
        case .external:
            decisionHandler(.cancel)
            if isActive { UIApplication.shared.open(url) }
        case .allow:
            if main {
                clearBridge()
                gatewayResponse = false
            }
            if action.targetFrame == nil {
                decisionHandler(.cancel)
                webView.load(URLRequest(url: url))
            } else {
                decisionHandler(action.shouldPerformDownload && profile.matches(url) ? .download : .allow)
            }
        }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        currentNavigation = navigation
        (presenter as? WorkspaceViewController)?.noteMainFrameStarted()
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard let url = response.response.url, profile.permitsTransport(url) else {
            logger.warning("workspace.security_refusal reason=response_transport")
            decisionHandler(.cancel)
            return
        }
        if response.isForMainFrame {
            if let http = response.response as? HTTPURLResponse,
               [401, 403].contains(http.statusCode) {
                let headers = http.allHeaderFields
                gatewayResponse = headers.keys.contains { String(describing: $0).lowercased().hasPrefix("cf-access-") } ||
                    (http.value(forHTTPHeaderField: "www-authenticate")?.localizedCaseInsensitiveContains("Cloudflare-Access") ?? false)
                if gatewayResponse { detach(gateway: true) }
            }
            if !profile.matches(url) && policy.phase != .gatewayHandoff {
                detach(gateway: false)
                logger.warning("workspace.security_refusal reason=response_origin")
                decisionHandler(.cancel)
                return
            }
        }
        decisionHandler(!response.canShowMIMEType && profile.matches(url) ? .download : .allow)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        guard !disposed, navigation === currentNavigation, !gatewayResponse,
              let url = webView.url, profile.matches(url), !profile.isGateway(url) else { return }
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            logger.error("workspace.bridge_randomness_failed")
            return
        }
        let token = bytes.map { String(format: "%02x", $0) }.joined()
        guard policy.commit(url, profile: profile, token: token) else { return }
        installBridge(token: token)
        onLocation?(url.path + (url.query.map { "?\($0)" } ?? "") + (url.fragment.map { "#\($0)" } ?? ""))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard navigation === currentNavigation else { return }
        (presenter as? WorkspaceViewController)?.noteMainFrameSettled()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        detach(gateway: false)
        logger.error("workspace.renderer_terminated")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        guard navigation === currentNavigation else { return }
        (presenter as? WorkspaceViewController)?.noteMainFrameFailed()
        detach(gateway: policy.phase == .gatewayHandoff)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        guard navigation === currentNavigation else { return }
        (presenter as? WorkspaceViewController)?.noteMainFrameFailed()
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction,
                 didBecome download: WKDownload) {
        exports.presenter = presenter
        exports.track(download)
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse,
                 didBecome download: WKDownload) {
        exports.presenter = presenter
        exports.track(download)
    }
}

final class WeakWorkspaceHandler: NSObject, WKScriptMessageHandler {
    weak var session: WorkspaceSession?
    init(_ session: WorkspaceSession) { self.session = session }
    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        session?.userContentController(userContentController, didReceive: message)
    }
}
