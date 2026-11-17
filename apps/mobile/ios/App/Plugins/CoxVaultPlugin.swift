import Capacitor
import Foundation
import LocalAuthentication
import Security
import WebKit

@objc(CoxVaultPlugin)
public class CoxVaultPlugin: CAPPlugin, CAPBridgedPlugin, URLSessionTaskDelegate {
    public let identifier = "CoxVaultPlugin"
    public let jsName = "CoxVault"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "savePassword", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unlockAndAutofillPassword", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deletePassword", returnType: CAPPluginReturnPromise)
    ]
    private let service = "dev.doublepi.cox.mobile.vault"
    private var active = Set<String>()
    private struct Credential: Codable {
        let canonicalOrigin: String
        let password: String
    }
    private enum VaultFailure: Error { case invalid, unavailable }

    private func identity(_ call: CAPPluginCall) throws -> String {
        guard let page = bridge?.webView?.url,
              page.scheme == "capacitor", page.host == "localhost",
              let id = call.getString("profileId"),
              let uuid = UUID(uuidString: id), uuid.uuidString.lowercased() == id,
              !active.contains(id) else { throw VaultFailure.invalid }
        return id
    }

    private func origin(_ call: CAPPluginCall) throws -> URL {
        guard let raw = call.getString("canonicalOrigin"),
              let parts = URLComponents(string: raw),
              parts.scheme == "https" || parts.scheme == "http",
              parts.host != nil, parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil, parts.path.isEmpty,
              let url = parts.url, url.absoluteString == raw else { throw VaultFailure.invalid }
        return url
    }

    private func query(_ id: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service, kSecAttrAccount as String: id]
    }

    @objc public func savePassword(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            do {
                let id = try self.identity(call)
                let url = try self.origin(call)
                guard let password = call.getString("password"), !password.isEmpty,
                      let biometric = call.getBool("requireBiometric") else { throw VaultFailure.invalid }
                let context = LAContext()
                let policy: LAPolicy = biometric ? .deviceOwnerAuthenticationWithBiometrics : .deviceOwnerAuthentication
                guard context.canEvaluatePolicy(policy, error: nil),
                      let access = SecAccessControlCreateWithFlags(
                        nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
                        biometric ? .biometryCurrentSet : .userPresence, nil
                      ) else { throw VaultFailure.unavailable }
                let data = try JSONEncoder().encode(Credential(canonicalOrigin: url.absoluteString, password: password))
                let attributes: [String: Any] = [
                    kSecAttrAccessControl as String: access,
                    kSecAttrLabel as String: url.absoluteString,
                    kSecAttrDescription as String: biometric ? "biometric" : "presence",
                    kSecValueData as String: data
                ]
                let status = SecItemUpdate(self.query(id) as CFDictionary, attributes as CFDictionary)
                if status == errSecItemNotFound {
                    guard SecItemAdd(self.query(id).merging(attributes) { _, value in value } as CFDictionary, nil) == errSecSuccess
                    else { throw VaultFailure.unavailable }
                } else if status != errSecSuccess { throw VaultFailure.unavailable }
                call.resolve()
            } catch { call.reject("The credential could not be saved.", "vault_unavailable") }
        }
    }

    @objc public func unlockAndAutofillPassword(_ call: CAPPluginCall) {
        Task { @MainActor in
            do {
                let id = try identity(call)
                guard let profileUuid = UUID(uuidString: id) else { throw VaultFailure.invalid }
                let requestedOrigin = try origin(call)
                guard requestedOrigin.scheme == "https" || call.getBool("allowInsecureHttp") == true
                else { throw VaultFailure.invalid }
                active.insert(id)
                defer { active.remove(id) }
                var attributesQuery = query(id)
                attributesQuery[kSecReturnAttributes as String] = true
                var attributesResult: CFTypeRef?
                guard SecItemCopyMatching(attributesQuery as CFDictionary, &attributesResult) == errSecSuccess,
                      let attributes = attributesResult as? [String: Any],
                      attributes[kSecAttrLabel as String] as? String == requestedOrigin.absoluteString
                else { throw VaultFailure.invalid }
                let context = LAContext()
                defer { context.invalidate() }
                let policy: LAPolicy = attributes[kSecAttrDescription as String] as? String == "biometric"
                    ? .deviceOwnerAuthenticationWithBiometrics : .deviceOwnerAuthentication
                guard try await context.evaluatePolicy(policy, localizedReason: "Unlock the Cox server password")
                else { throw VaultFailure.unavailable }
                var secretQuery = query(id)
                secretQuery[kSecReturnData as String] = true
                secretQuery[kSecUseAuthenticationContext as String] = context
                var secretResult: CFTypeRef?
                guard SecItemCopyMatching(secretQuery as CFDictionary, &secretResult) == errSecSuccess,
                      let data = secretResult as? Data else { throw VaultFailure.unavailable }
                let stored = try JSONDecoder().decode(Credential.self, from: data)
                guard stored.canonicalOrigin == requestedOrigin.absoluteString else { throw VaultFailure.invalid }
                var request = URLRequest(url: requestedOrigin.appendingPathComponent("api/auth/browser-session"))
                request.httpMethod = "POST"
                request.setValue(requestedOrigin.absoluteString, forHTTPHeaderField: "Origin")
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                for (field, value) in await WorkspaceCookies.headerFields(for: requestedOrigin, profileId: profileUuid) {
                    request.setValue(value, forHTTPHeaderField: field)
                }
                request.httpBody = try JSONSerialization.data(withJSONObject: ["credential": stored.password])
                let configuration = URLSessionConfiguration.ephemeral
                configuration.httpCookieStorage = nil
                configuration.httpShouldSetCookies = false
                configuration.timeoutIntervalForRequest = 20
                configuration.timeoutIntervalForResource = 30
                let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
                defer { session.invalidateAndCancel() }
                let (_, response) = try await session.data(for: request)
                guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                      http.url == request.url,
                      let header = http.value(forHTTPHeaderField: "Set-Cookie") else { throw VaultFailure.unavailable }
                let cookies = HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": header], for: requestedOrigin)
                guard !cookies.isEmpty,
                      cookies.allSatisfy({ $0.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")) == requestedOrigin.host })
                else { throw VaultFailure.invalid }
                let cookieStore = WKWebsiteDataStore(forIdentifier: profileUuid).httpCookieStore
                for cookie in cookies { await cookieStore.setCookie(cookie) }
                call.resolve()
            } catch { call.reject("The credential could not be unlocked.", "vault_unavailable") }
        }
    }

    @objc public func deletePassword(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            do {
                let id = try self.identity(call)
                let status = SecItemDelete(self.query(id) as CFDictionary)
                guard status == errSecSuccess || status == errSecItemNotFound else { throw VaultFailure.unavailable }
                call.resolve()
            } catch { call.reject("The credential could not be removed.", "vault_unavailable") }
        }
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask,
                           willPerformHTTPRedirection response: HTTPURLResponse,
                           newRequest request: URLRequest,
                           completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
