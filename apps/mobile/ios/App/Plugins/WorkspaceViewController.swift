import UIKit
import WebKit

final class WorkspaceViewController: UIViewController {
    var onLauncher: ((String) -> Void)?
    private let pill = UIButton(type: .system)
    private weak var workspace: WKWebView?
    private var keyboardVisible = false
    private var draggingPill = false
    private let dockKey = "cox.workspace.serversPill.dockRight"
    private let yKey = "cox.workspace.serversPill.yFraction"
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
        pill.frame = CGRect(x: 8, y: 8, width: 84, height: 36)
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
        guard !draggingPill else { return }
        placePill(dockRight: UserDefaults.standard.object(forKey: dockKey) as? Bool ?? true,
                  fraction: UserDefaults.standard.object(forKey: yKey) as? Double ?? 0.5)
    }

    private func band() -> (minX: CGFloat, maxX: CGFloat, minY: CGFloat, maxY: CGFloat)? {
        let safe = view.safeAreaLayoutGuide.layoutFrame
        guard safe.width > 0, safe.height > 0, pill.bounds.width > 0 else { return nil }
        let margin: CGFloat = 8
        let minX = safe.minX + margin
        let maxX = max(minX, safe.maxX - margin - pill.bounds.width)
        let minY = safe.minY + 56
        let maxY = max(minY, safe.maxY - 112 - pill.bounds.height)
        return (minX, maxX, minY, maxY)
    }

    private func placePill(dockRight: Bool, fraction: Double) {
        guard let band = band() else { return }
        let y = band.minY + (band.maxY - band.minY) * CGFloat(min(max(fraction, 0), 1))
        pill.frame.origin = CGPoint(x: dockRight ? band.maxX : band.minX, y: y)
    }

    @objc private func openSwitcher() { onLauncher?("openServerSwitcher") }

    @objc private func drag(_ gesture: UIPanGestureRecognizer) {
        guard let band = band() else { return }
        if gesture.state == .began || gesture.state == .changed { draggingPill = true }
        let translation = gesture.translation(in: view)
        var origin = pill.frame.origin
        origin.x = min(max(origin.x + translation.x, band.minX), band.maxX)
        origin.y = min(max(origin.y + translation.y, band.minY), band.maxY)
        pill.frame.origin = origin
        gesture.setTranslation(.zero, in: view)
        if gesture.state == .ended || gesture.state == .cancelled {
            let safe = view.safeAreaLayoutGuide.layoutFrame
            let dockRight = pill.center.x >= safe.midX
            let span = max(band.maxY - band.minY, 1)
            let fraction = Double((pill.frame.minY - band.minY) / span)
            UserDefaults.standard.set(dockRight, forKey: dockKey)
            UserDefaults.standard.set(min(max(fraction, 0), 1), forKey: yKey)
            placePill(dockRight: dockRight, fraction: fraction)
            draggingPill = false
        }
    }
}
