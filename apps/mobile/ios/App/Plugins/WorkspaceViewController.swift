import UIKit
import WebKit

final class WorkspaceViewController: UIViewController {
    var onLauncher: ((String) -> Void)?
    private let pill = UIButton(type: .system)
    private weak var workspace: WKWebView?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        pill.setTitle("Servers", for: .normal)
        pill.accessibilityLabel = "Open server switcher"
        pill.backgroundColor = .secondarySystemBackground
        pill.layer.cornerRadius = 22
        pill.layer.shadowOpacity = 0.25
        pill.frame = CGRect(x: 12, y: 120, width: 100, height: 44)
        pill.addTarget(self, action: #selector(openSwitcher), for: .touchUpInside)
        pill.addGestureRecognizer(UIPanGestureRecognizer(target: self, action: #selector(drag)))
        pill.menu = UIMenu(children: [
            UIAction(title: "Connection Manager") { [weak self] _ in
                self?.onLauncher?("openConnectionManager")
            },
            UIAction(title: "Reload") { [weak self] _ in self?.workspace?.reload() }
        ])
        view.addSubview(pill)
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
        clampPill()
    }

    private func clampPill() {
        let safe = view.safeAreaLayoutGuide.layoutFrame
        pill.center = CGPoint(
            x: min(max(pill.center.x, safe.minX + 50), safe.maxX - 50),
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
            pill.center.x = pill.center.x < safe.midX ? safe.minX + 50 : safe.maxX - 50
        }
    }
}
