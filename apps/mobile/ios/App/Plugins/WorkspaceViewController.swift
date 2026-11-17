import UIKit
import WebKit

final class WorkspaceViewController: UIViewController {
    var onLauncher: ((String) -> Void)?
    private let pill = UIButton(type: .system)
    private weak var workspace: WKWebView?
    private var keyboardVisible = false
    private var positioned = false
    var webSwitcherMounted = false {
        didSet { updatePillVisibility() }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.07, green: 0.07, blue: 0.08, alpha: 1)
        let isZh = Locale.preferredLanguages.first?.lowercased().hasPrefix("zh") == true
        pill.setTitle(isZh ? "服务器" : "Servers", for: .normal)
        pill.titleLabel?.font = .systemFont(ofSize: 13, weight: .medium)
        pill.accessibilityLabel = "Open server switcher"
        pill.backgroundColor = .secondarySystemBackground.withAlphaComponent(0.92)
        pill.setTitleColor(.label, for: .normal)
        pill.layer.cornerRadius = 18
        pill.layer.borderWidth = 1 / UIScreen.main.scale
        pill.layer.borderColor = UIColor.separator.cgColor
        pill.layer.shadowOpacity = 0.18
        pill.layer.shadowRadius = 6
        pill.layer.shadowOffset = CGSize(width: 0, height: 2)
        pill.frame = CGRect(x: 12, y: 12, width: 84, height: 36)
        pill.addTarget(self, action: #selector(openSwitcher), for: .touchUpInside)
        pill.addGestureRecognizer(UIPanGestureRecognizer(target: self, action: #selector(drag)))
        pill.menu = UIMenu(children: [
            UIAction(title: isZh ? "连接管理" : "Connection Manager") { [weak self] _ in
                self?.onLauncher?("openConnectionManager")
            },
            UIAction(title: isZh ? "刷新" : "Reload") { [weak self] _ in self?.workspace?.reload() }
        ])
        view.addSubview(pill)
        NotificationCenter.default.addObserver(
            self, selector: #selector(keyboardWillShow),
            name: UIResponder.keyboardWillShowNotification, object: nil
        )
        NotificationCenter.default.addObserver(
            self, selector: #selector(keyboardWillHide),
            name: UIResponder.keyboardWillHideNotification, object: nil
        )
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    @objc private func keyboardWillShow() {
        keyboardVisible = true
        updatePillVisibility()
    }

    @objc private func keyboardWillHide() {
        keyboardVisible = false
        updatePillVisibility()
    }

    private func updatePillVisibility() {
        pill.isHidden = keyboardVisible || webSwitcherMounted
    }

    func display(_ webView: WKWebView) {
        loadViewIfNeeded()
        workspace?.removeFromSuperview()
        workspace = webView
        webView.removeFromSuperview()
        view.insertSubview(webView, belowSubview: pill)
        webView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let safe = view.safeAreaLayoutGuide.layoutFrame
        if !positioned && safe.width > 0 {
            positioned = true
            pill.center = CGPoint(x: safe.maxX - 54, y: safe.minY + 28)
        }
        clampPill()
    }

    private func clampPill() {
        let safe = view.safeAreaLayoutGuide.layoutFrame
        guard safe.width > 0, safe.height > 0 else { return }
        pill.center = CGPoint(
            x: min(max(pill.center.x, safe.minX + 46), safe.maxX - 46),
            y: min(max(pill.center.y, safe.minY + 22), safe.maxY - 22)
        )
    }

    @objc private func openSwitcher() { onLauncher?("openServerSwitcher") }

    @objc private func drag(_ gesture: UIPanGestureRecognizer) {
        let translation = gesture.translation(in: view)
        pill.center = CGPoint(x: pill.center.x + translation.x, y: pill.center.y + translation.y)
        gesture.setTranslation(.zero, in: view)
        clampPill()
        if gesture.state == .ended {
            let safe = view.safeAreaLayoutGuide.layoutFrame
            pill.center.x = pill.center.x < safe.midX ? safe.minX + 46 : safe.maxX - 46
        }
    }
}
