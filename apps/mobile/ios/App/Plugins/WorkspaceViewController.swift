import UIKit
import WebKit

enum WorkspaceSafeAreaBootstrap {
    static var source = ""

    static func install(on controller: WKUserContentController) {
        guard !source.isEmpty else { return }
        controller.addUserScript(
            WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )
    }

    static func script(right: CGFloat, left: CGFloat) -> String {
        """
        (function(){
          var root = document.documentElement;
          if (!root) return;
          root.style.setProperty('--cox-safe-right','\(css(right))');
          root.style.setProperty('--cox-safe-left','\(css(left))');
        })();
        """
    }

    private static func css(_ value: CGFloat) -> String {
        String(format: "%.2fpx", value)
    }
}

final class WorkspaceViewController: UIViewController, UIGestureRecognizerDelegate {
    var onLauncher: ((String) -> Void)?
    private let fallback = UIButton(type: .system)
    private let edgeBack = UIScreenEdgePanGestureRecognizer()
    private weak var workspace: WKWebView?
    private var webTopToSafe: NSLayoutConstraint?
    private var webTopToFallback: NSLayoutConstraint?
    private var webBottomToKeyboard: NSLayoutConstraint?
    private var workspaceScrollObservations: [NSKeyValueObservation] = []
    private var publishedSafeArea = ""
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
        for name in [UIResponder.keyboardWillShowNotification, UIResponder.keyboardDidHideNotification] {
            NotificationCenter.default.addObserver(
                self, selector: #selector(updateKeyboardLayout(_:)), name: name, object: nil
            )
        }
        UserDefaults.standard.removeObject(forKey: "cox.workspace.serversPill.dockRight")
        UserDefaults.standard.removeObject(forKey: "cox.workspace.serversPill.yFraction")
        view.backgroundColor = Self.canvasColor(for: traitCollection)
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
        let keyboardVisible = webBottomToKeyboard?.isActive == true
        webBottomToKeyboard?.isActive = false
        workspaceScrollObservations.removeAll()
        workspace?.removeFromSuperview()
        workspace = webView
        webView.removeFromSuperview()
        view.insertSubview(webView, belowSubview: fallback)
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.addGestureRecognizer(edgeBack)
        webView.isOpaque = false
        webView.backgroundColor = Self.canvasColor(for: traitCollection)
        webView.scrollView.backgroundColor = webView.backgroundColor
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        let painted = webView.url != nil && !webView.isLoading
        webView.alpha = painted ? 1 : 0
        if painted { webView.isOpaque = true }
        let topSafe = webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor)
        let topFallback = webView.topAnchor.constraint(equalTo: fallback.bottomAnchor, constant: 6)
        webTopToSafe = topSafe
        webTopToFallback = topFallback
        let bottomToSafe = webView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor)
        bottomToSafe.priority = .defaultHigh
        let bottomToKeyboard = webView.bottomAnchor.constraint(lessThanOrEqualTo: view.keyboardLayoutGuide.topAnchor)
        webBottomToKeyboard = bottomToKeyboard
        NSLayoutConstraint.activate([
            bottomToSafe,
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        bottomToKeyboard.isActive = keyboardVisible
        let scrollView = webView.scrollView
        workspaceScrollObservations = [
            scrollView.observe(\.contentSize) { [weak self] _, _ in
                self?.constrainKeyboardScrollOffset()
            },
            scrollView.observe(\.contentOffset) { [weak self] _, _ in
                self?.constrainKeyboardScrollOffset()
            },
        ]
        updateFallback()
        publishSafeArea()
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        publishSafeArea()
    }

    @objc private func updateKeyboardLayout(_ notification: Notification) {
        guard let screen = view.window?.windowScene?.screen,
              (notification.object as? UIScreen) === screen else { return }
        webBottomToKeyboard?.isActive = notification.name == UIResponder.keyboardWillShowNotification
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        constrainKeyboardScrollOffset()
        publishSafeArea()
    }

    private func constrainKeyboardScrollOffset() {
        guard webBottomToKeyboard?.isActive == true, let workspace,
              workspace.frame.maxY <= view.keyboardLayoutGuide.layoutFrame.minY + 1 else { return }
        let scrollView = workspace.scrollView
        guard scrollView.contentSize.height > 0,
              !scrollView.isDragging, !scrollView.isDecelerating else { return }
        let insets = scrollView.contentInset
        let bottomOffset = max(-insets.top, scrollView.contentSize.height - scrollView.bounds.height + insets.bottom)
        if scrollView.contentOffset.y > bottomOffset + 1 {
            scrollView.contentOffset.y = bottomOffset
        }
    }

    private func publishSafeArea() {
        guard let workspace, workspace.bounds.height > 0 else { return }
        let host: UIView = view.window ?? view
        let hostInsets = host.safeAreaInsets
        let frame = workspace.convert(workspace.bounds, to: host)
        let left = max(0, hostInsets.left - frame.minX)
        let right = max(0, frame.maxX - (host.bounds.maxX - hostInsets.right))
        let signature = String(format: "%.2f,%.2f", right, left)
        if signature == publishedSafeArea { return }
        publishedSafeArea = signature
        let script = WorkspaceSafeAreaBootstrap.script(right: right, left: left)
        WorkspaceSafeAreaBootstrap.source = script
        workspace.evaluateJavaScript(script) { _, error in
            if error != nil { self.publishedSafeArea = "" }
        }
    }

    func noteMainFrameStarted() {
        publishedSafeArea = ""
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
        publishedSafeArea = ""
        publishSafeArea()
        revealWorkspaceContent()
        guard !pageFailed else { return }
        scheduleFallbackReveal()
    }

    func noteMainFrameFailed() {
        revealItem?.cancel()
        pageFailed = true
        revealFallback = true
        revealWorkspaceContent()
        updateFallback()
    }

    private func revealWorkspaceContent() {
        guard let workspace, workspace.alpha < 1 else { return }
        if UIAccessibility.isReduceMotionEnabled {
            workspace.alpha = 1
            workspace.isOpaque = true
            return
        }
        UIView.animate(withDuration: 0.18, delay: 0, options: .curveEaseOut) {
            workspace.alpha = 1
        } completion: { _ in
            workspace.isOpaque = true
        }
    }

    private static func canvasColor(for traits: UITraitCollection) -> UIColor {
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 7 / 255, green: 9 / 255, blue: 8 / 255, alpha: 1)
            : UIColor(red: 245 / 255, green: 247 / 255, blue: 243 / 255, alpha: 1)
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
