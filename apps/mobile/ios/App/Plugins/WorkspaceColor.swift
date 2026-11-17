import Foundation

enum WorkspaceColor {
    private static let number = #"[+-]?(?:\d+(?:\.\d+)?|\.\d+)"#

    private static func matches(_ value: String, _ pattern: String) -> Bool {
        value.range(of: "^(?:\(pattern))$", options: .regularExpression) != nil
    }

    private static func inRange(_ value: String, _ bounds: ClosedRange<Double>, percent: Bool = false) -> Bool {
        guard matches(value, number + (percent ? "%" : "")),
              let parsed = Double(percent ? String(value.dropLast()) : value) else { return false }
        return parsed.isFinite && bounds.contains(parsed)
    }

    private static func alpha(_ value: String) -> Bool {
        inRange(value, 0...1) || inRange(value, 0...100, percent: true)
    }

    static func isValid(_ value: String) -> Bool {
        guard !value.isEmpty, value.utf16.count <= 64,
              value == value.trimmingCharacters(in: .whitespaces),
              value.unicodeScalars.allSatisfy({ $0.value >= 32 && $0.value <= 126 }) else { return false }
        if matches(value, "#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})") { return true }
        guard let open = value.firstIndex(of: "("), value.hasSuffix(")") else { return false }
        let name = String(value[..<open])
        let body = String(value[value.index(after: open)..<value.index(before: value.endIndex)])
            .trimmingCharacters(in: .whitespaces)
        let channels: [String]
        if body.contains(",") {
            guard name != "oklch", !body.contains("/") else { return false }
            let parts = body.components(separatedBy: ",").map { $0.trimmingCharacters(in: .whitespaces) }
            guard parts.count == 3 || parts.count == 4,
                  parts.allSatisfy({ !$0.isEmpty && !$0.contains(" ") }),
                  parts.count != 4 || alpha(parts[3]) else { return false }
            channels = Array(parts.prefix(3))
        } else {
            let segments = body.components(separatedBy: "/")
            guard segments.count == 1 || segments.count == 2,
                  segments.count != 2 || alpha(segments[1].trimmingCharacters(in: .whitespaces)) else { return false }
            channels = segments[0].split(separator: " ").map(String.init)
            guard channels.count == 3 else { return false }
        }
        switch name {
        case "rgb", "rgba":
            return channels.allSatisfy { inRange($0, 0...255) } ||
                channels.allSatisfy { inRange($0, 0...100, percent: true) }
        case "hsl", "hsla":
            return matches(channels[0], number + "(?:deg|rad|grad|turn)?") &&
                inRange(channels[1], 0...100, percent: true) &&
                inRange(channels[2], 0...100, percent: true)
        case "oklch":
            let chroma = channels[1]
            let numericChroma = chroma.hasSuffix("%") ? String(chroma.dropLast()) : chroma
            return (inRange(channels[0], 0...1) || inRange(channels[0], 0...100, percent: true)) &&
                matches(numericChroma, number) && (Double(numericChroma) ?? -1) >= 0 &&
                matches(channels[2], number + "(?:deg|rad|grad|turn)?")
        default: return false
        }
    }
}
