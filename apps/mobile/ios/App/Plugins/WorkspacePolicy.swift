import Foundation

struct WorkspaceProfile {
    let id: UUID
    let origin: URL
    let allowInsecureHttp: Bool
    let label: String
    let serverCount: Int
    let lastThreadPath: String?
    let gatewayLogin: Bool

    static func validID(_ input: String) -> UUID? {
        guard input.range(
            of: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
            options: .caseInsensitive.union(.regularExpression)
        ) != nil else { return nil }
        return UUID(uuidString: input)
    }

    static func canonicalOrigin(_ input: String, allowHTTP: Bool) -> URL? {
        guard let url = URL(string: input), let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty, url.scheme == "https" || (allowHTTP && url.scheme == "http"),
              input == originString(url) else { return nil }
        return url
    }

    static func originString(_ url: URL) -> String {
        guard let scheme = url.scheme, let host = url.host else { return "" }
        let port = url.port ?? (scheme == "https" ? 443 : 80)
        let suffix = (scheme == "https" && port == 443) || (scheme == "http" && port == 80)
            ? "" : ":\(port)"
        return "\(scheme.lowercased())://\(host.lowercased())\(suffix)"
    }

    func matches(_ url: URL) -> Bool {
        url.user == nil && url.password == nil &&
            Self.originString(url) == origin.absoluteString
    }

    func permitsTransport(_ url: URL) -> Bool {
        url.user == nil && url.password == nil &&
            (url.scheme == "https" || (allowInsecureHttp && url.scheme == "http"))
    }

    func isGateway(_ url: URL) -> Bool {
        url.scheme == "https" &&
            ((url.host?.hasSuffix(".cloudflareaccess.com") ?? false) ||
             (matches(url) && url.path.hasPrefix("/cdn-cgi/access/")))
    }

    var startURL: URL {
        guard let path = lastThreadPath, path.hasPrefix("/"), !path.hasPrefix("//"),
              let url = URL(string: path, relativeTo: origin)?.absoluteURL, matches(url)
        else { return origin }
        return url
    }
}

struct WorkspacePolicy {
    enum Phase { case loading, ready, gatewayHandoff }
    enum Decision { case allow, external, refuse }
    var phase: Phase = .loading
    var generation = 0
    var bridgeToken: String?

    mutating func detach(gateway: Bool) {
        phase = gateway ? .gatewayHandoff : .loading
        generation += 1
        bridgeToken = nil
    }

    mutating func navigate(_ url: URL, profile: WorkspaceProfile, main: Bool) -> Decision {
        guard profile.permitsTransport(url) else { return .refuse }
        guard main else { return .allow }
        let gateway = profile.isGateway(url) || phase == .gatewayHandoff
        guard profile.matches(url) || gateway else { return .external }
        detach(gateway: gateway)
        return .allow
    }

    mutating func commit(_ url: URL, profile: WorkspaceProfile, token: String) -> Bool {
        guard profile.matches(url), !profile.isGateway(url) else { return false }
        phase = .ready
        bridgeToken = token
        return true
    }

    func acceptsToken(_ candidate: String) -> Bool {
        guard phase == .ready, let token = bridgeToken else { return false }
        let actual = Array(candidate.utf8)
        let expected = Array(token.utf8)
        var difference = actual.count ^ expected.count
        for index in expected.indices {
            difference |= Int(expected[index] ^ (index < actual.count ? actual[index] : 0))
        }
        return difference == 0
    }
}
