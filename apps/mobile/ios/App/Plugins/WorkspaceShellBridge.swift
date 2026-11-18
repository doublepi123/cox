import Foundation
import UIKit
import WebKit

extension WorkspaceSession {
    func installBridge(token: String) {
        let info: [String: Any] = [
            "platform": "ios", "activeServerLabel": profile.label, "serverCount": profile.serverCount
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: [
            "info": info, "bridgeToken": token, "origin": profile.origin.absoluteString
        ], options: [.sortedKeys]),
              let json = String(data: data, encoding: .utf8) else { return }
        let script = """
        (() => {
          const config = \(json);
          if (window !== window.top || location.origin !== config.origin) return;
          const post = payload => window.webkit.messageHandlers.coxMobileShell.postMessage(payload);
          window.__coxMobileShell__ = Object.freeze({
            info: Object.freeze(config.info),
            bridgeToken: config.bridgeToken,
            postMessage: post
          });
          window.dispatchEvent(new Event("cox:mobile-shell-change"));
          const sync = () => {
            const bodyBg = document.body ? getComputedStyle(document.body).backgroundColor : null;
            const rootBg = document.documentElement ? getComputedStyle(document.documentElement).backgroundColor : null;
            const meta = document.querySelector('meta[name="theme-color"]')?.getAttribute("content");
            const chosen = [bodyBg, rootBg, meta].find(v => v && v !== "transparent" && v !== "rgba(0, 0, 0, 0)");
            if (chosen) post({ type: "syncThemeColor", color: chosen, bridgeToken: config.bridgeToken });
          };
          sync();
          if (!window.__coxChromeObserverInstalled__) {
            window.__coxChromeObserverInstalled__ = true;
            let timer = 0;
            new MutationObserver(() => {
              clearTimeout(timer);
              timer = setTimeout(sync, 40);
            }).observe(document.documentElement, {
              attributes: true,
              subtree: true,
              childList: true,
              attributeFilter: ["class", "style", "data-theme-id", "content"]
            });
          }
        })();
        """
        let controller = webView.configuration.userContentController
        controller.removeScriptMessageHandler(forName: "coxMobileShell")
        controller.add(WeakWorkspaceHandler(self), name: "coxMobileShell")
        controller.removeAllUserScripts()
        installViewportLock()
        controller.addUserScript(WKUserScript(
            source: script, injectionTime: .atDocumentEnd, forMainFrameOnly: true
        ))
        webView.evaluateJavaScript(script, completionHandler: nil)
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard isActive, message.frameInfo.isMainFrame else {
            logger.warning("workspace.security_refusal reason=frame")
            return
        }
        let origin = message.frameInfo.securityOrigin
        var components = URLComponents()
        components.scheme = origin.protocol
        components.host = origin.host
        components.port = origin.port == 0 ? nil : origin.port
        guard let source = components.url, profile.matches(source),
              let current = webView.url, profile.matches(current) else {
            logger.warning("workspace.security_refusal reason=origin")
            return
        }
        guard let payload = message.body as? [String: Any],
              let token = payload["bridgeToken"] as? String, policy.acceptsToken(token) else {
            logger.warning("workspace.security_refusal reason=token")
            return
        }
        guard let request = WorkspaceShellRequest(payload) else {
            logger.warning("workspace.security_refusal reason=payload")
            return
        }
        switch request {
        case .openServerSwitcher:
            onLauncher?("openServerSwitcher")
        case .setServerSwitcherProvided(let provided):
            guard let workspace = presenter as? WorkspaceViewController else { return }
            workspace.webSwitcherMounted = provided
            if !provided { workspace.noteMainFrameSettled() }
        case .openConnectionManager:
            onLauncher?("openConnectionManager")
        case .hapticSelection:
            UISelectionFeedbackGenerator().selectionChanged()
        case .syncThemeColor(let color):
            guard let data = try? JSONSerialization.data(withJSONObject: [color]),
                  let argument = String(data: data, encoding: .utf8) else { return }
            let generation = policy.generation
            webView.evaluateJavaScript("""
            (() => {
              const color = \(argument)[0];
              if (!CSS.supports("color", color)) return null;
              const canvas = document.createElement("canvas");
              canvas.width = canvas.height = 1;
              const context = canvas.getContext("2d");
              context.fillStyle = color; context.fillRect(0, 0, 1, 1);
              return Array.from(context.getImageData(0, 0, 1, 1).data);
            })()
            """) { [weak self] result, _ in
                guard let self, self.policy.generation == generation, self.isActive,
                      let rgba = result as? [Double], rgba.count == 4,
                      rgba.allSatisfy({ $0 >= 0 && $0 <= 255 }) else { return }
                self.presenter?.view.backgroundColor = UIColor(
                    red: rgba[0] / 255, green: rgba[1] / 255,
                    blue: rgba[2] / 255, alpha: rgba[3] / 255
                )
            }
        case .saveBlobDownload(let name, let data):
            exports.presenter = presenter
            exports.save(data, filename: name)
        }
    }
}

enum WorkspaceShellRequest {
    case openServerSwitcher, openConnectionManager, hapticSelection
    case setServerSwitcherProvided(Bool)
    case syncThemeColor(String)
    case saveBlobDownload(String, Data)

    init?(_ payload: [String: Any]) {
        guard let type = payload["type"] as? String else { return nil }
        switch type {
        case "openServerSwitcher": self = .openServerSwitcher
        case "setServerSwitcherProvided":
            guard let provided = payload["provided"] as? Bool else { return nil }
            self = .setServerSwitcherProvided(provided)
        case "openConnectionManager": self = .openConnectionManager
        case "hapticSelection": self = .hapticSelection
        case "syncThemeColor":
            guard let color = payload["color"] as? String, WorkspaceColor.isValid(color) else { return nil }
            self = .syncThemeColor(color)
        case "saveBlobDownload":
            guard let filename = payload["filename"] as? String,
                  Self.safeFilename(filename),
                  let mime = payload["mimeType"] as? String, mime.count <= 128,
                  let dataURL = payload["dataUrl"] as? String,
                  dataURL.utf8.count <= 22_369_624 + 4096,
                  dataURL.hasPrefix("data:"), let comma = dataURL.firstIndex(of: ",") else { return nil }
            let header = dataURL[..<comma]
            let encoded = String(dataURL[dataURL.index(after: comma)...])
            let data: Data?
            if header.hasSuffix(";base64") { data = Data(base64Encoded: encoded) }
            else { data = encoded.removingPercentEncoding?.data(using: .utf8) }
            guard let data, data.count <= 16 * 1024 * 1024 else { return nil }
            self = .saveBlobDownload(filename, data)
        default: return nil
        }
    }

    static func safeFilename(_ name: String) -> Bool {
        !name.isEmpty && name.utf16.count <= 255 && !name.contains("..") &&
            !name.contains("/") && !name.contains("\\") &&
            name.unicodeScalars.allSatisfy { $0.value >= 32 && $0.value != 127 }
    }
}
