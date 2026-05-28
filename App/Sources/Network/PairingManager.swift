import Foundation
import Security
import CryptoKit

// MARK: - Wire types

private struct PairCompleteRequest: Encodable {
    let code: String
    let csrPem: String
    let deviceName: String

    enum CodingKeys: String, CodingKey {
        case code
        case csrPem    = "csr_pem"
        case deviceName = "device_name"
    }
}

private struct PairCompleteResponse: Decodable {
    let certPem: String
    let caPem: String
    // `device` object present but not used by the app beyond storage.

    enum CodingKeys: String, CodingKey {
        case certPem = "cert_pem"
        case caPem   = "ca_pem"
    }
}

// MARK: - PairingError

enum PairingError: LocalizedError {
    case keyGenerationFailed(OSStatus)
    case csrSigningFailed(Error)
    case publicKeyExportFailed(OSStatus)
    case badServerCertificate
    case badServerResponse(String)
    case identityCreationFailed
    case caFingerprintMismatch

    var errorDescription: String? {
        switch self {
        case .keyGenerationFailed(let s):   return "Key generation failed (OSStatus \(s))"
        case .csrSigningFailed(let e):      return "CSR signing failed: \(e.localizedDescription)"
        case .publicKeyExportFailed(let s): return "Public key export failed (OSStatus \(s))"
        case .badServerCertificate:         return "Server certificate validation failed"
        case .badServerResponse(let m):     return "Bad server response: \(m)"
        case .identityCreationFailed:       return "Could not build client identity from signed certificate"
        case .caFingerprintMismatch:        return "Server CA fingerprint does not match expected value"
        }
    }
}

// MARK: - PairingManager

@Observable
final class PairingManager: NSObject {

    var isPairing: Bool = false
    var error: String? = nil
    var isPaired: Bool = false

    private let hub: HubInfo

    init(hub: HubInfo) {
        self.hub = hub
        super.init()
        self.isPaired = KeychainStore.shared.isPaired(for: hub.id)
    }

    // MARK: - Public API

    func pair(code: String, deviceName: String) async throws {
        isPairing = true
        error = nil
        defer { isPairing = false }

        do {
            // 1. Generate 2048-bit RSA key pair.
            let (privateKey, publicKey) = try generateRSAKeyPair()

            // 2. Build and sign the PKCS#10 CSR.
            let csrPEM = try buildCSR(privateKey: privateKey, publicKey: publicKey, cn: deviceName)

            // 3. POST to /api/pair/complete using a pinning-aware session.
            let session = makePairingSession()
            let body = PairCompleteRequest(code: code, csrPem: csrPEM, deviceName: deviceName)
            let response = try await postPairComplete(body: body, session: session)

            // 4. Decode the signed certificate.
            guard let signedCert = KeychainStore.shared.certificate(
                fromPEMString: response.certPem) else {
                throw PairingError.badServerResponse("cert_pem could not be parsed as DER certificate")
            }

            // 5-6. Persist key + cert in Keychain (iOS pairs them automatically into a SecIdentity).
            try KeychainStore.shared.saveKeyAndCert(privateKey: privateKey, certificate: signedCert, for: hub.id)
            let caData = Data(response.caPem.utf8)
            try KeychainStore.shared.saveCACert(caData, for: hub.id)

            isPaired = true
        } catch {
            self.error = error.localizedDescription
            throw error
        }
    }

    func unpair() {
        try? KeychainStore.shared.deleteIdentity(for: hub.id)
        try? KeychainStore.shared.deleteCACert(for: hub.id)
        isPaired = false
    }

    // MARK: - Key generation

    private func generateRSAKeyPair() throws -> (privateKey: SecKey, publicKey: SecKey) {
        let attributes: [CFString: Any] = [
            kSecAttrKeyType:       kSecAttrKeyTypeRSA,
            kSecAttrKeySizeInBits: 2048,
            kSecPrivateKeyAttrs: [
                kSecAttrIsPermanent:    false, // ephemeral; we persist the identity after pairing
                kSecAttrApplicationTag: "com.briannadoubt.scope.pairing.\(hub.id)".data(using: .utf8)!,
            ] as [CFString: Any],
        ]

        var error: Unmanaged<CFError>?
        guard let privateKey = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
            let err = error?.takeRetainedValue() as Error? ?? NSError(domain: "PairingManager", code: -1)
            throw PairingError.csrSigningFailed(err)
        }
        guard let publicKey = SecKeyCopyPublicKey(privateKey) else {
            throw PairingError.keyGenerationFailed(errSecParam)
        }
        return (privateKey, publicKey)
    }

    // MARK: - CSR construction

    /// Build a minimal PKCS#10 CertificationRequest (RFC 2986) and PEM-wrap it.
    ///
    /// Structure:
    ///   CertificationRequest ::= SEQUENCE {
    ///       tbsCertificationRequest  TBSCertificationRequest,
    ///       signatureAlgorithm       AlgorithmIdentifier,      -- sha256WithRSAEncryption
    ///       signature                BIT STRING
    ///   }
    private func buildCSR(privateKey: SecKey, publicKey: SecKey, cn: String) throws -> String {
        // Export SubjectPublicKeyInfo DER from the Security key.
        var exportError: Unmanaged<CFError>?
        guard let pubKeyData = SecKeyCopyExternalRepresentation(publicKey, &exportError) as Data? else {
            let err = exportError?.takeRetainedValue() as Error? ?? NSError(domain: "PairingManager", code: -2)
            throw PairingError.csrSigningFailed(err)
        }

        // `pubKeyData` from SecKeyCopyExternalRepresentation for RSA is the raw PKCS#1 DER.
        // Wrap it in a SubjectPublicKeyInfo: SEQUENCE { AlgorithmIdentifier, BIT STRING }.
        let spki = buildSPKI(rsaPKCS1DER: pubKeyData)

        // Build TBSCertificationRequest.
        let tbs = buildTBS(cn: cn, spki: spki)

        // Sign TBS with SHA-256/RSA.
        let signature = try signData(tbs, with: privateKey)

        // Wrap into CertificationRequest.
        let certificationRequest = derSequence(
            tbs +
            sha256WithRSAEncryptionAlgorithmIdentifier() +
            derBitString(signature)
        )

        // PEM-encode.
        let b64 = certificationRequest.base64EncodedString(options: [.lineLength64Characters, .endLineWithLineFeed])
        return "-----BEGIN CERTIFICATE REQUEST-----\n\(b64)\n-----END CERTIFICATE REQUEST-----\n"
    }

    // MARK: - DER building helpers

    private func derLength(_ length: Int) -> Data {
        if length < 0x80 {
            return Data([UInt8(length)])
        } else if length <= 0xFF {
            return Data([0x81, UInt8(length)])
        } else {
            return Data([0x82, UInt8(length >> 8), UInt8(length & 0xFF)])
        }
    }

    private func derTag(_ tag: UInt8, _ contents: Data) -> Data {
        Data([tag]) + derLength(contents.count) + contents
    }

    private func derSequence(_ contents: Data) -> Data { derTag(0x30, contents) }
    private func derSet(_ contents: Data) -> Data      { derTag(0x31, contents) }

    private func derOID(_ bytes: [UInt8]) -> Data {
        derTag(0x06, Data(bytes))
    }

    private func derUTF8String(_ s: String) -> Data {
        let d = Data(s.utf8)
        return derTag(0x0C, d)
    }

    private func derBitString(_ data: Data) -> Data {
        // 0x00 prefix = zero unused bits in the last byte.
        var contents = Data([0x00])
        contents.append(data)
        return derTag(0x03, contents)
    }

    private func derNull() -> Data { Data([0x05, 0x00]) }

    /// OID 1.2.840.113549.1.1.11 = sha256WithRSAEncryption
    private func sha256WithRSAEncryptionOID() -> Data {
        derOID([0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x0B])
    }

    /// OID 1.2.840.113549.1.1.1 = rsaEncryption
    private func rsaEncryptionOID() -> Data {
        derOID([0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x01])
    }

    /// OID 2.5.4.3 = commonName
    private func commonNameOID() -> Data {
        derOID([0x55, 0x04, 0x03])
    }

    private func sha256WithRSAEncryptionAlgorithmIdentifier() -> Data {
        derSequence(sha256WithRSAEncryptionOID() + derNull())
    }

    /// Build SubjectPublicKeyInfo wrapping a PKCS#1 RSA public key.
    private func buildSPKI(rsaPKCS1DER: Data) -> Data {
        let algorithmIdentifier = derSequence(rsaEncryptionOID() + derNull())
        let bitString = derBitString(rsaPKCS1DER)
        return derSequence(algorithmIdentifier + bitString)
    }

    /// Build the DER-encoded subject: SEQUENCE { SET { SEQUENCE { OID_cn, UTF8String(cn) } } }
    private func buildSubject(cn: String) -> Data {
        let attrTypeAndValue = derSequence(commonNameOID() + derUTF8String(cn))
        let relativeDistinguishedName = derSet(attrTypeAndValue)
        let rdnSequence = derSequence(relativeDistinguishedName)
        return rdnSequence
    }

    /// Build the TBSCertificationRequest DER bytes.
    ///
    ///   TBSCertificationRequest ::= SEQUENCE {
    ///       version       INTEGER { v1(0) },
    ///       subject           RDNSequence,
    ///       subjectPKInfo     SubjectPublicKeyInfo,
    ///       attributes    [0] IMPLICIT SET OF Attribute {{ CRIAttributes }}
    ///   }
    ///
    /// RFC 2986 §4: version is always 0 for PKCS#10 v1.
    private func buildTBS(cn: String, spki: Data) -> Data {
        // version INTEGER value 0: tag 0x02, length 0x01, value 0x00.
        let version = Data([0x02, 0x01, 0x00])
        let subject = buildSubject(cn: cn)
        // Attributes: [0] IMPLICIT (context-specific, constructed), empty set — tag A0, length 00.
        let attributes = Data([0xA0, 0x00])
        let tbsContents = version + subject + spki + attributes
        return derSequence(tbsContents)
    }

    private func signData(_ data: Data, with privateKey: SecKey) throws -> Data {
        var error: Unmanaged<CFError>?
        guard let sig = SecKeyCreateSignature(
            privateKey,
            .rsaSignatureMessagePKCS1v15SHA256,
            data as CFData,
            &error
        ) as Data? else {
            let err = error?.takeRetainedValue() as Error? ?? NSError(domain: "PairingManager", code: -3)
            throw PairingError.csrSigningFailed(err)
        }
        return sig
    }

    // MARK: - Network

    private func makePairingSession() -> URLSession {
        URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
    }

    private func postPairComplete(body: PairCompleteRequest, session: URLSession) async throws -> PairCompleteResponse {
        let url = hub.baseURL.appendingPathComponent("/api/pair/complete")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let encoder = JSONEncoder()
        request.httpBody = try encoder.encode(body)

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw PairingError.badServerResponse("non-HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? "<binary>"
            throw PairingError.badServerResponse("HTTP \(http.statusCode): \(body)")
        }

        let decoder = JSONDecoder()
        do {
            return try decoder.decode(PairCompleteResponse.self, from: data)
        } catch {
            throw PairingError.badServerResponse("JSON decode failed: \(error.localizedDescription)")
        }
    }

}

// MARK: - URLSessionDelegate (initial pairing trust)

extension PairingManager: URLSessionDelegate {

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        switch challenge.protectionSpace.authenticationMethod {

        case NSURLAuthenticationMethodServerTrust:
            guard let serverTrust = challenge.protectionSpace.serverTrust else {
                completionHandler(.cancelAuthenticationChallenge, nil)
                return
            }
            handleServerTrust(serverTrust: serverTrust, completionHandler: completionHandler)

        default:
            // No client certificate during initial pairing — we don't have one yet.
            completionHandler(.performDefaultHandling, nil)
        }
    }

    private func handleServerTrust(
        serverTrust: SecTrust,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard let fingerprint = hub.caFingerprint else {
            // No pinned fingerprint — trust anything (first-time discovery).
            completionHandler(.useCredential, URLCredential(trust: serverTrust))
            return
        }

        // Extract the certificate chain using the iOS 15+ API.
        guard let chainRef = SecTrustCopyCertificateChain(serverTrust) else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        // CFArray elements are always SecCertificate here — forced cast is correct.
        let chain = chainRef as! [SecCertificate]
        guard let leafCert = chain.first else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        let leafData = SecCertificateCopyData(leafCert) as Data

        guard let caCert = chain.last else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        let caData = SecCertificateCopyData(caCert) as Data

        // Compute SHA-256 of the CA cert DER and compare to hub.caFingerprint.
        let caHash = SHA256.hash(data: caData)
        let caHex  = caHash.compactMap { String(format: "%02x", $0) }.joined()

        // Also try the leaf in case it is self-signed.
        let leafHash = SHA256.hash(data: leafData)
        let leafHex  = leafHash.compactMap { String(format: "%02x", $0) }.joined()

        let normalizedPin = fingerprint.lowercased().replacingOccurrences(of: ":", with: "")

        if caHex == normalizedPin || leafHex == normalizedPin {
            completionHandler(.useCredential, URLCredential(trust: serverTrust))
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }
}
