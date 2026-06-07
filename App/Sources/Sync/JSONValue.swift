import Foundation

// MARK: - JSONValue (SCP-135)
//
// A small type-erased JSON value used for opaque event payloads in the sync
// wire format. Event payloads are kind-specific; the iOS client acts as a
// transport/replica and only needs to *carry* most payloads verbatim and peek
// at a couple of fields (e.g. `ticketId`). Modeling them as `JSONValue` keeps
// the envelope Codable while round-tripping unknown shapes byte-for-byte, so a
// newly added server `kind` never breaks decode/encode.

enum JSONValue: Codable, Hashable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    // MARK: Decoding

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let b = try? container.decode(Bool.self) {
            self = .bool(b)
        } else if let n = try? container.decode(Double.self) {
            self = .number(n)
        } else if let s = try? container.decode(String.self) {
            self = .string(s)
        } else if let a = try? container.decode([JSONValue].self) {
            self = .array(a)
        } else if let o = try? container.decode([String: JSONValue].self) {
            self = .object(o)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container, debugDescription: "Unsupported JSON value")
        }
    }

    // MARK: Encoding

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null:            try container.encodeNil()
        case .bool(let b):     try container.encode(b)
        case .number(let n):   try container.encode(n)
        case .string(let s):   try container.encode(s)
        case .array(let a):    try container.encode(a)
        case .object(let o):   try container.encode(o)
        }
    }

    // MARK: Accessors

    var object: [String: JSONValue]? {
        if case .object(let o) = self { return o }
        return nil
    }

    var array: [JSONValue]? {
        if case .array(let a) = self { return a }
        return nil
    }

    var string: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    var int: Int? {
        if case .number(let n) = self { return Int(n) }
        return nil
    }

    var bool: Bool? {
        if case .bool(let b) = self { return b }
        return nil
    }
}
