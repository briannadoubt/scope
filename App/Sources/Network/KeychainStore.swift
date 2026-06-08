import Foundation
import Security

// MARK: - Errors

enum KeychainError: LocalizedError {
    case unexpectedStatus(OSStatus)
    case badData
    case missingCertificate

    var errorDescription: String? {
        switch self {
        case .unexpectedStatus(let status):
            if let msg = SecCopyErrorMessageString(status, nil) {
                return "Keychain error: \(msg)"
            }
            return "Keychain error: OSStatus \(status)"
        case .badData:
            return "Keychain returned unexpected data type"
        case .missingCertificate:
            return "Could not extract certificate from identity"
        }
    }
}

// MARK: - KeychainStore

// Stateless wrapper around the Security framework (no mutable stored state), so
// the shared singleton is safe to use concurrently.
final class KeychainStore: Sendable {

    static let shared = KeychainStore()

    private init() {}

    // MARK: - Label helpers

    private func identityLabel(for hubId: String) -> String { "scope.identity.\(hubId)" }
    private func caCertLabel(for hubId: String) -> String    { "scope.ca.\(hubId)" }

    // MARK: - SecIdentity (client private key + certificate)

    /// Persists a `SecIdentity` (private key + its certificate) under the given hub id.
    func saveIdentity(_ identity: SecIdentity, for hubId: String) throws {
        // Extract the certificate so we can store it alongside the key.
        var certRef: SecCertificate?
        let extractStatus = SecIdentityCopyCertificate(identity, &certRef)
        guard extractStatus == errSecSuccess, let cert = certRef else {
            throw KeychainError.unexpectedStatus(extractStatus)
        }

        // Delete any pre-existing entry first to avoid duplicates.
        try? deleteIdentity(for: hubId)

        let label = identityLabel(for: hubId) as CFString
        let addQuery: [CFString: Any] = [
            kSecClass:           kSecClassIdentity,
            kSecValueRef:        identity,
            kSecAttrLabel:       label,
            kSecAttrAccessible:  kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemAdd(addQuery as CFDictionary, nil)
        // errSecDuplicateItem can still appear on some OS versions; treat it as success.
        guard status == errSecSuccess || status == errSecDuplicateItem else {
            throw KeychainError.unexpectedStatus(status)
        }

        // Also stash the certificate separately so we can retrieve it by class.
        let certQuery: [CFString: Any] = [
            kSecClass:          kSecClassCertificate,
            kSecValueRef:       cert,
            kSecAttrLabel:      label,
            kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let certStatus = SecItemAdd(certQuery as CFDictionary, nil)
        guard certStatus == errSecSuccess || certStatus == errSecDuplicateItem else {
            throw KeychainError.unexpectedStatus(certStatus)
        }
    }

    /// iOS-compatible identity creation: stores the private key and signed certificate
    /// separately in the keychain, then queries for the `SecIdentity` that iOS forms by
    /// matching them on their public key.
    func saveKeyAndCert(privateKey: SecKey, certificate: SecCertificate, for hubId: String) throws {
        let label = identityLabel(for: hubId) as CFString

        // Remove any pre-existing entry so we don't hit errSecDuplicateItem.
        try? deleteIdentity(for: hubId)

        // 1. Store the private key.
        let keyAttrs: [CFString: Any] = [
            kSecClass:          kSecClassKey,
            kSecAttrKeyClass:   kSecAttrKeyClassPrivate,
            kSecValueRef:       privateKey,
            kSecAttrLabel:      label,
            kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let keyStatus = SecItemAdd(keyAttrs as CFDictionary, nil)
        guard keyStatus == errSecSuccess || keyStatus == errSecDuplicateItem else {
            throw KeychainError.unexpectedStatus(keyStatus)
        }

        // 2. Store the certificate.
        let certAttrs: [CFString: Any] = [
            kSecClass:          kSecClassCertificate,
            kSecValueRef:       certificate,
            kSecAttrLabel:      label,
            kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let certStatus = SecItemAdd(certAttrs as CFDictionary, nil)
        guard certStatus == errSecSuccess || certStatus == errSecDuplicateItem else {
            throw KeychainError.unexpectedStatus(certStatus)
        }
    }

    func loadIdentity(for hubId: String) -> SecIdentity? {
        let label = identityLabel(for: hubId) as CFString
        let query: [CFString: Any] = [
            kSecClass:       kSecClassIdentity,
            kSecAttrLabel:   label,
            kSecReturnRef:   kCFBooleanTrue!,
            kSecMatchLimit:  kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let ref = result else { return nil }
        // swiftlint:disable:next force_cast
        return (ref as! SecIdentity)
    }

    func deleteIdentity(for hubId: String) throws {
        let label = identityLabel(for: hubId) as CFString

        // Remove the private key.
        let keyQuery: [CFString: Any] = [kSecClass: kSecClassKey, kSecAttrLabel: label]
        let s1 = SecItemDelete(keyQuery as CFDictionary)
        guard s1 == errSecSuccess || s1 == errSecItemNotFound else {
            throw KeychainError.unexpectedStatus(s1)
        }

        // Remove the certificate.
        let certQuery: [CFString: Any] = [kSecClass: kSecClassCertificate, kSecAttrLabel: label]
        let s2 = SecItemDelete(certQuery as CFDictionary)
        guard s2 == errSecSuccess || s2 == errSecItemNotFound else {
            throw KeychainError.unexpectedStatus(s2)
        }
    }

    // MARK: - CA certificate (for server-trust pinning)

    func saveCACert(_ pemData: Data, for hubId: String) throws {
        guard let cert = certificate(fromPEM: pemData) else {
            throw KeychainError.badData
        }

        try? deleteCACert(for: hubId)

        let label = caCertLabel(for: hubId) as CFString
        let addQuery: [CFString: Any] = [
            kSecClass:          kSecClassCertificate,
            kSecValueRef:       cert,
            kSecAttrLabel:      label,
            kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemAdd(addQuery as CFDictionary, nil)
        guard status == errSecSuccess || status == errSecDuplicateItem else {
            throw KeychainError.unexpectedStatus(status)
        }
    }

    func loadCACert(for hubId: String) -> SecCertificate? {
        let label = caCertLabel(for: hubId) as CFString
        let query: [CFString: Any] = [
            kSecClass:      kSecClassCertificate,
            kSecAttrLabel:  label,
            kSecReturnRef:  kCFBooleanTrue!,
            kSecMatchLimit: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let ref = result else { return nil }
        // swiftlint:disable:next force_cast
        return (ref as! SecCertificate)
    }

    func deleteCACert(for hubId: String) throws {
        let label = caCertLabel(for: hubId) as CFString
        let query: [CFString: Any] = [
            kSecClass:     kSecClassCertificate,
            kSecAttrLabel: label,
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.unexpectedStatus(status)
        }
    }

    // MARK: - Paired check

    func isPaired(for hubId: String) -> Bool {
        loadIdentity(for: hubId) != nil
    }

    // MARK: - PEM helpers

    /// Convert a PEM-encoded certificate to a `SecCertificate`.
    func certificate(fromPEM pemData: Data) -> SecCertificate? {
        guard let pem = String(data: pemData, encoding: .utf8) else { return nil }
        return certificate(fromPEMString: pem)
    }

    func certificate(fromPEMString pem: String) -> SecCertificate? {
        let stripped = pem
            .components(separatedBy: "\n")
            .filter { !$0.hasPrefix("-----") && !$0.isEmpty }
            .joined()
        guard let der = Data(base64Encoded: stripped, options: .ignoreUnknownCharacters) else {
            return nil
        }
        return SecCertificateCreateWithData(nil, der as CFData)
    }
}
