import Foundation

/// Shared ISO-8601 date parse/format helper for the JSON coders.
///
/// `ISO8601DateFormatter`'s parse/format methods are documented thread-safe, but
/// the type isn't `Sendable`. Wrapping the configured instances in an
/// `@unchecked Sendable` holder lets the `@Sendable` JSON coder closures (in
/// HubClient and SyncWire) capture it without a strict-concurrency warning.
final class ISODates: @unchecked Sendable {
    private let fractional = ISO8601DateFormatter()
    private let plain = ISO8601DateFormatter()
    init() {
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        plain.formatOptions = [.withInternetDateTime]
    }
    func parse(_ s: String) -> Date? { fractional.date(from: s) ?? plain.date(from: s) }
    func format(_ d: Date) -> String { fractional.string(from: d) }
}

/// Module-wide shared instance.
let isoDates = ISODates()
