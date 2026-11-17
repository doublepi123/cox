import Capacitor
import Foundation
import UIKit
import WebKit

private let allowedPreflightPaths: Set<String> = ["/.well-known/t3/environment", "/api/auth/session"]

final class WorkspaceNoRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

enum WorkspaceCookies {
    static func matches(_ cookie: HTTPCookie, url: URL) -> Bool {
        if let expires = cookie.expiresDate, expires <= Date() { return false }
        if cookie.isSecure && url.scheme?.lowercased() != "https" { return false }
        guard let host = url.host?.lowercased() else { return false }
        let rawDomain = cookie.domain.lowercased()
        let bareDomain = rawDomain.hasPrefix(".") ? String(rawDomain.dropFirst()) : rawDomain
        let domainMatches = host == bareDomain ||
            (rawDomain.hasPrefix(".") && host.hasSuffix(".\(bareDomain)"))
        guard domainMatches else { return false }
        let urlPath = url.path.isEmpty ? "/" : url.path
        let cookiePath = cookie.path.isEmpty ? "/" : cookie.path
        if urlPath == cookiePath { return true }
        guard urlPath.hasPrefix(cookiePath) else { return false }
        return cookiePath.hasSuffix("/") ||
            urlPath[urlPath.index(urlPath.startIndex, offsetBy: cookiePath.count)] == "/"
    }

    @MainActor
    static func headerFields(for url: URL, profileId: UUID) async -> [String: String] {
        let store = WKWebsiteDataStore(forIdentifier: profileId).httpCookieStore
        let allCookies = await store.allCookies()
        let matching = allCookies.filter { matches($0, url: url) }
        return matching.isEmpty ? [:] : HTTPCookie.requestHeaderFields(with: matching)
    }
}

enum WorkspacePreflight {
    static func isLauncher(_ page: URL?) -> Bool {
        page?.scheme == "capacitor" && page?.host == "localhost"
    }

    @MainActor
    static func requestProfileUrl(_ call: CAPPluginCall, page: URL?) async {
        let allowHTTP = call.getBool("allowInsecureHttp") == true
        guard isLauncher(page),
              let id = call.getString("profileId").flatMap(WorkspaceProfile.validID),
              let originInput = call.getString("origin"),
              let origin = WorkspaceProfile.canonicalOrigin(originInput, allowHTTP: allowHTTP),
              let urlInput = call.getString("url"),
              let targetUrl = URL(string: urlInput),
              targetUrl.user == nil, targetUrl.password == nil,
              targetUrl.query == nil, targetUrl.fragment == nil,
              WorkspaceProfile.originString(targetUrl) == origin.absoluteString,
              allowedPreflightPaths.contains(targetUrl.path) else {
            call.reject("Invalid preflight request.", "invalid_request")
            return
        }
        var request = URLRequest(url: targetUrl)
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        for (field, value) in await WorkspaceCookies.headerFields(for: targetUrl, profileId: id) {
            request.setValue(value, forHTTPHeaderField: field)
        }
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 20
        let delegate = WorkspaceNoRedirectDelegate()
        let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                call.reject("Invalid HTTP response.", "network_error")
                return
            }
            var headers: [String: String] = [:]
            for (rawKey, rawValue) in http.allHeaderFields {
                let key = String(describing: rawKey).lowercased()
                if key == "set-cookie" { continue }
                headers[key] = String(describing: rawValue)
            }
            let body: String
            if (300..<400).contains(http.statusCode) {
                body = ""
            } else {
                let slice = data.prefix(1_000_001)
                body = String(decoding: slice, as: UTF8.self)
            }
            call.resolve(["status": http.statusCode, "headers": headers, "body": body])
        } catch {
            call.reject("The server could not be reached.", "network_error", error)
        }
    }
}

final class WorkspaceGatewaySignInController: UIViewController, WKNavigationDelegate, UIAdaptivePresentationControllerDelegate {
    private let profileId: UUID
    private let origin: URL
    private let onFinish: (Result<Void, Error>) -> Void
    private var webView: WKWebView?
    private var settled = false
    private var readyToComplete = false

    struct CancelledError: Error {}

    init(profileId: UUID, origin: URL, onFinish: @escaping (Result<Void, Error>) -> Void) {
        self.profileId = profileId
        self.origin = origin
        self.onFinish = onFinish
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Cloudflare Access"
        view.backgroundColor = UIColor(red: 0.08, green: 0.08, blue: 0.09, alpha: 1)
        navigationItem.rightBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .cancel, target: self, action: #selector(cancelTapped)
        )
        let config = WKWebViewConfiguration()
        config.websiteDataStore = WKWebsiteDataStore(forIdentifier: profileId)
        let wk = WKWebView(frame: .zero, configuration: config)
        wk.translatesAutoresizingMaskIntoConstraints = false
        wk.navigationDelegate = self
        wk.allowsBackForwardNavigationGestures = true
        wk.isInspectable = false
        view.addSubview(wk)
        NSLayoutConstraint.activate([
            wk.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            wk.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            wk.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            wk.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        webView = wk
        wk.load(URLRequest(url: origin, cachePolicy: .reloadIgnoringLocalCacheData))
    }

    @objc private func cancelTapped() {
        complete(.failure(CancelledError()))
    }

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        complete(.failure(CancelledError()))
    }

    private func complete(_ result: Result<Void, Error>) {
        guard !settled else { return }
        settled = true
        webView?.stopLoading()
        webView?.navigationDelegate = nil
        if presentingViewController != nil {
            dismiss(animated: true) { [onFinish] in onFinish(result) }
        } else {
            onFinish(result)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url, url.scheme?.lowercased() == "https",
              url.host != nil, url.user == nil, url.password == nil else {
            decisionHandler(.cancel)
            return
        }
        if action.targetFrame == nil {
            decisionHandler(.cancel)
            webView.load(URLRequest(url: url))
            return
        }
        if action.targetFrame?.isMainFrame ?? true { readyToComplete = false }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard let url = response.response.url, url.scheme?.lowercased() == "https" else {
            decisionHandler(.cancel)
            return
        }
        if response.isForMainFrame, let http = response.response as? HTTPURLResponse {
            let cfGate = [401, 403].contains(http.statusCode) && (
                http.allHeaderFields.keys.contains { String(describing: $0).lowercased().hasPrefix("cf-access-") } ||
                (http.value(forHTTPHeaderField: "www-authenticate")?.localizedCaseInsensitiveContains("Cloudflare-Access") ?? false)
            )
            readyToComplete = !cfGate && (200..<400).contains(http.statusCode) &&
                WorkspaceProfile.originString(url) == origin.absoluteString &&
                !url.path.hasPrefix("/cdn-cgi/")
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard readyToComplete, let url = webView.url,
              WorkspaceProfile.originString(url) == origin.absoluteString,
              !url.path.hasPrefix("/cdn-cgi/") else { return }
        complete(.success(()))
    }
}
