import Capacitor
import OSLog
import UIKit
import WebKit

@objc(CoxWorkspaceWebViewPlugin)
public final class CoxWorkspaceWebViewPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CoxWorkspaceWebViewPlugin"
    public let jsName = "CoxWorkspaceWebView"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "requestProfileUrl", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signInToGateway", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openWorkspace", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "closeWorkspace", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "forgetProfile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "syncLauncherTheme", returnType: CAPPluginReturnPromise)
    ]
    private var sessions: [UUID: WorkspaceSession] = [:]
    private var recent: [UUID] = []
    private var active: UUID?
    private var deleting: Set<UUID> = []
    private var preparing: [UUID: UUID] = [:]
    private var host: WorkspaceViewController?
    private var transitioning = false
    private var pendingReturn: String?
    private let logger = Logger(subsystem: "dev.doublepi.cox.mobile", category: "workspace")

    public override func load() {
        NotificationCenter.default.addObserver(
            self, selector: #selector(memoryWarning),
            name: UIApplication.didReceiveMemoryWarningNotification, object: nil
        )
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    @objc public func syncLauncherTheme(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            (self?.bridge?.viewController as? CoxLauncherViewController)?
                .applyStatusBar(forHex: call.getString("color"))
            call.resolve()
        }
    }

    @objc public func requestProfileUrl(_ call: CAPPluginCall) {
        Task { @MainActor [weak self] in
            await WorkspacePreflight.requestProfileUrl(call, page: self?.bridge?.webView?.url)
        }
    }

    @objc public func signInToGateway(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, WorkspacePreflight.isLauncher(self.bridge?.webView?.url),
                  let id = call.getString("profileId").flatMap(WorkspaceProfile.validID),
                  let input = call.getString("origin"),
                  let origin = WorkspaceProfile.canonicalOrigin(input, allowHTTP: false),
                  !self.deleting.contains(id),
                  let presenter = self.bridge?.viewController else {
                return call.reject("Cloudflare Access sign-in unavailable.", "gateway_unavailable")
            }
            self.dispose(id)
            let controller = WorkspaceGatewaySignInController(profileId: id, origin: origin) { result in
                switch result {
                case .success:
                    call.resolve()
                case .failure:
                    call.reject("Cloudflare Access sign-in was cancelled.", "gateway_cancelled")
                }
            }
            let nav = UINavigationController(rootViewController: controller)
            nav.modalPresentationStyle = .pageSheet
            nav.presentationController?.delegate = controller
            presenter.present(nav, animated: true)
        }
    }

    @objc public func openWorkspace(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return call.reject("Workspace unavailable.") }
            guard !self.transitioning else { return call.reject("Workspace is switching.") }
            guard let id = call.getString("profileId").flatMap(WorkspaceProfile.validID),
                  let input = call.getString("origin"),
                  let origin = WorkspaceProfile.canonicalOrigin(
                    input, allowHTTP: call.getBool("allowInsecureHttp") == true
                  ), !self.deleting.contains(id) else {
                self.logger.warning("workspace.security_refusal reason=profile")
                return call.reject("Invalid workspace profile.")
            }
            let profile = WorkspaceProfile(
                id: id, origin: origin, allowInsecureHttp: call.getBool("allowInsecureHttp") == true,
                label: call.getString("label") ?? "", serverCount: call.getInt("serverCount") ?? 1,
                lastThreadPath: call.getString("lastThreadPath"),
                gatewayLogin: call.getBool("gatewayLogin") == true
            )
            self.preparing.removeAll()
            if let existing = self.sessions[id],
               existing.profile.origin != origin ||
                existing.profile.allowInsecureHttp != profile.allowInsecureHttp ||
                existing.profile.label != profile.label ||
                existing.profile.serverCount != profile.serverCount ||
                existing.pageState == .failed {
                self.dispose(id)
            }
            if let session = self.sessions[id] {
                self.show(session, call: call)
                return
            }
            self.prepare(profile, call: call)
        }
    }

    private func prepare(_ profile: WorkspaceProfile, call: CAPPluginCall) {
        let ticket = UUID()
        preparing[profile.id] = ticket
        let rules = profile.allowInsecureHttp ?
            #"[{"trigger":{"url-filter":"^file:"},"action":{"type":"block"}}]"# :
            #"[{"trigger":{"url-filter":"^http://"},"action":{"type":"block"}}]"#
        WKContentRuleListStore.default().compileContentRuleList(
            forIdentifier: "cox-transport-\(profile.allowInsecureHttp)",
            encodedContentRuleList: rules
        ) { [weak self] rules, error in
            guard let self else {
                return call.reject("Could not enforce workspace transport policy.")
            }
            guard self.preparing[profile.id] == ticket, !self.deleting.contains(profile.id), !self.transitioning else {
                return call.reject("Workspace open was superseded.")
            }
            self.preparing.removeValue(forKey: profile.id)
            guard let rules, error == nil else {
                return call.reject("Could not enforce workspace transport policy.")
            }
            while self.recent.count >= 2 { self.dispose(self.recent[0]) }
            let configuration = WKWebViewConfiguration()
            configuration.allowsInlineMediaPlayback = true
            configuration.websiteDataStore = WKWebsiteDataStore(forIdentifier: profile.id)
            configuration.userContentController.add(rules)
            let session = WorkspaceSession(profile: profile, configuration: configuration)
            session.onLauncher = { [weak self] event in self?.returnToLauncher(event) }
            session.onLocation = { [weak self] path in
                self?.notifyListeners("workspaceLocation", data: [
                    "profileId": profile.id.uuidString.lowercased(), "path": path
                ])
            }
            self.sessions[profile.id] = session
            self.show(session, call: call)
        }
    }

    private func show(_ session: WorkspaceSession, call: CAPPluginCall) {
        guard let presenter = bridge?.viewController, presenter.viewIfLoaded?.window != nil,
              presenter.presentedViewController === host else {
            return call.reject("Workspace unavailable.")
        }
        if let active, let previous = sessions[active], previous !== session {
            previous.isActive = false
            previous.presenter = nil
            previous.exports.presenter = nil
        }
        active = session.profile.id
        recent.removeAll { $0 == session.profile.id }
        recent.append(session.profile.id)
        let controller = host ?? WorkspaceViewController()
        session.presenter = controller
        session.isActive = true
        controller.display(session)
        if session.webView.url == nil && !session.webView.isLoading {
            session.webView.load(URLRequest(url: session.profile.startURL, cachePolicy: .reloadIgnoringLocalCacheData))
        }
        if host == nil {
            controller.onLauncher = { [weak self] event in self?.returnToLauncher(event) }
            controller.modalPresentationStyle = .overFullScreen
            controller.modalTransitionStyle = .crossDissolve
            host = controller
            transitioning = true
            presenter.present(controller, animated: !UIAccessibility.isReduceMotionEnabled) { [weak self] in
                self?.transitioning = false
                call.resolve()
                if let self, let event = self.pendingReturn {
                    self.pendingReturn = nil
                    self.returnToLauncher(event)
                }
            }
        } else {
            session.resumeInterruptedContent()
            call.resolve()
        }
    }

    private func dispose(_ id: UUID) {
        sessions.removeValue(forKey: id)?.dispose()
        recent.removeAll { $0 == id }
        if active == id { active = nil }
    }

    @objc private func memoryWarning() {
        for id in recent where id != active { dispose(id) }
    }

    private func returnToLauncher(_ event: String) {
        preparing.removeAll()
        guard let host else { return }
        if transitioning {
            if active != nil { pendingReturn = event }
            return
        }
        if let id = active, let session = sessions[id] {
            session.isActive = false
            session.presenter = nil
            session.exports.presenter = nil
            if session.pageState == .loading || session.pageState == .failed { dispose(id) }
        }
        active = nil
        transitioning = true
        host.dismiss(animated: !UIAccessibility.isReduceMotionEnabled) { [weak self] in
            self?.host = nil
            self?.transitioning = false
            self?.notifyListeners(event, data: [:])
        }
    }

    @objc public func closeWorkspace(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.returnToLauncher("openConnectionManager")
            call.resolve()
        }
    }

    @objc public func forgetProfile(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let id = call.getString("profileId").flatMap(WorkspaceProfile.validID),
                  !self.deleting.contains(id) else {
                return call.reject("Invalid or busy profile.")
            }
            self.deleting.insert(id)
            self.preparing.removeValue(forKey: id)
            if self.active == id { self.returnToLauncher("openConnectionManager") }
            self.dispose(id)
            Task { @MainActor in
                do {
                    try await WKWebsiteDataStore.remove(forIdentifier: id)
                    self.deleting.remove(id)
                    call.resolve()
                } catch {
                    self.deleting.remove(id)
                    self.logger.error("workspace.data_store_removal_failed")
                    call.reject("Could not remove this profile's website data.")
                }
            }
        }
    }
}
