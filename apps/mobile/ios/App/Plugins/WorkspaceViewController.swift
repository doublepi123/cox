import UIKit
import WebKit

final class WorkspaceViewController: UIViewController, UIGestureRecognizerDelegate {
    var onLauncher: ((String) -> Void)?
    private let fallback = UIButton(type: .system)
    private let edgeBack = UIScreenEdgePanGestureRecognizer()
    private weak var workspace: WKWebView?
    private var webTopToSafe: NSLayoutConstraint?
    private var webTopToFallback: NSLayoutConstraint?
    private var pageFailed = false
    private var revealFallback = false
    private var revealItem: DispatchWorkItem?
    var webSwitcherMounted = false {
        didSet {
            if webSwitcherMounted {
                revealItem?.cancel()
                revealFallback = false
                pageFailed = false
            }
            updateFallback()
        }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        UserDefaults.standard.removeObject(forKey: "cox.workspace.serversPill.dockRight")
        UserDefaults.standard.removeObject(forKey: "cox.workspace.serversPill.yFraction")
        view.backgroundColor = UIColor(red: 0.07, green: 0.07, blue: 0.08, alpha: 1)
        let isZh = Locale.preferredLanguages.first?.lowercased().hasPrefix("zh") == true
        var configuration = UIButton.Configuration.plain()
        configuration.title = isZh ? "返回" : "Back"
        configuration.baseForegroundColor = .label
        configuration.contentInsets = NSDirectionalEdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12)
        configuration.background.backgroundColor = .secondarySystemBackground
        configuration.background.cornerRadius = 8
        fallback.configuration = configuration
        fallback.accessibilityLabel = isZh ? "连接管理" : "Connection Manager"
        fallback.translatesAutoresizingMaskIntoConstraints = false
        fallback.isHidden = true
        fallback.addTarget(self, action: #selector(leaveWorkspace), for: .touchUpInside)
        view.addSubview(fallback)
        NSLayoutConstraint.activate([
            fallback.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 6),
            fallback.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 12),
        ])
        edgeBack.edges = .left
        edgeBack.delegate = self
        edgeBack.addTarget(self, action: #selector(edgeBackFired))
    }

    func display(_ webView: WKWebView) {
        loadViewIfNeeded()
        edgeBack.view?.removeGestureRecognizer(edgeBack)
        webTopToSafe?.isActive = false
        webTopToFallback?.isActive = false
        workspace?.removeFromSuperview()
        workspace = webView
        webView.removeFromSuperview()
        view.insertSubview(webView, belowSubview: fallback)
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.addGestureRecognizer(edgeBack)
        let topSafe = webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor)
        let topFallback = webView.topAnchor.constraint(equalTo: fallback.bottomAnchor, constant: 6)
        webTopToSafe = topSafe
        webTopToFallback = topFallback
        NSLayoutConstraint.activate([
            webView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        updateFallback()
    }

    func noteMainFrameStarted() {
        pageFailed = false
        revealFallback = false
        revealItem?.cancel()
        if webSwitcherMounted {
            webSwitcherMounted = false
        } else {
            updateFallback()
        }
    }

    func noteMainFrameSettled() {
        guard !pageFailed else { return }
        scheduleFallbackReveal()
    }

    func noteMainFrameFailed() {
        revealItem?.cancel()
        pageFailed = true
        revealFallback = true
        updateFallback()
    }

    private func scheduleFallbackReveal() {
        revealItem?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.webSwitcherMounted else { return }
            self.revealFallback = true
            self.updateFallback()
        }
        revealItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0, execute: work)
    }

    private func updateFallback() {
        let show = pageFailed || (revealFallback && !webSwitcherMounted)
        fallback.isHidden = !show
        webTopToSafe?.isActive = !show
        webTopToFallback?.isActive = show
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        if gestureRecognizer === edgeBack { return workspace?.canGoBack != true }
        return true
    }

    @objc private func leaveWorkspace() { onLauncher?("openConnectionManager") }

    @objc private func edgeBackFired(_ gesture: UIScreenEdgePanGestureRecognizer) {
        guard gesture.state == .ended, workspace?.canGoBack != true else { return }
        leaveWorkspace()
    }
}
