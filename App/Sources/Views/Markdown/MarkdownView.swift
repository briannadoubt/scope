import SwiftUI

/// Renders a ticket description (or any Markdown blob) with native Markdown
/// for prose and a `WKWebView` for Mermaid fenced blocks.
///
/// **Why split:** Apple's `AttributedString(markdown:)` covers the common
/// inline markup (bold/italic/links/code) plus block structure under
/// `.full` interpretation, which is good enough for typical ticket bodies.
/// Mermaid diagrams need a real layout engine + the mermaid runtime, so they
/// ride in their own `MermaidView` (see that file for the WKWebView setup).
///
/// The view splits the input on ```mermaid``` fences in linear time, so a
/// description with N diagrams produces N+1 text segments interleaved with
/// N Mermaid views. Non-mermaid fenced blocks (e.g. ```swift```) flow back
/// through AttributedString and render as monospaced code.
struct MarkdownView: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(MarkdownSegment.split(text).enumerated()), id: \.offset) { _, seg in
                switch seg {
                case .prose(let md):
                    prose(md)
                case .mermaid(let src):
                    MermaidView(source: src)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func prose(_ md: String) -> some View {
        // `.full` interpretation walks block structure (headings, lists, code
        // fences). Fall back to plain text if the parser rejects something
        // exotic — never want a malformed description to break the screen.
        if let attributed = try? AttributedString(
            markdown: md,
            options: .init(
                allowsExtendedAttributes: false,
                interpretedSyntax: .full,
                failurePolicy: .returnPartiallyParsedIfPossible
            )
        ) {
            Text(attributed)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            Text(md)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

// MARK: - Segment splitter

enum MarkdownSegment: Equatable {
    case prose(String)
    case mermaid(String)

    /// Splits the input into alternating prose / mermaid segments.
    ///
    /// Detection is intentionally narrow: a line that starts with ```` ```mermaid````
    /// (optionally followed by whitespace) opens a Mermaid block; the next
    /// line that is exactly ```` ``` ```` closes it. Everything else stays in
    /// the surrounding prose chunk so AttributedString's parser handles its
    /// own fences (```swift, etc.) normally.
    ///
    /// Empty prose chunks are dropped so we don't emit zero-height
    /// placeholders in the surrounding `VStack`.
    static func split(_ input: String) -> [MarkdownSegment] {
        var out: [MarkdownSegment] = []
        var prose: [String] = []
        var diagram: [String] = []
        var inMermaid = false

        let lines = input.components(separatedBy: "\n")
        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if !inMermaid {
                // Opening fence — accept ```mermaid or ~~~mermaid, with no
                // extra info after `mermaid`.
                if isMermaidOpener(trimmed) {
                    flushProse(&prose, into: &out)
                    inMermaid = true
                    continue
                }
                prose.append(line)
            } else {
                // Closing fence — three backticks (or tildes) on their own
                // line, ignoring trailing whitespace.
                if isFenceClose(trimmed) {
                    out.append(.mermaid(diagram.joined(separator: "\n")))
                    diagram.removeAll()
                    inMermaid = false
                    continue
                }
                diagram.append(line)
            }
        }

        // Unterminated mermaid block — treat the partial diagram as prose so
        // nothing gets lost on a half-finished edit.
        if inMermaid {
            prose.append("```mermaid")
            prose.append(contentsOf: diagram)
        }
        flushProse(&prose, into: &out)
        return out
    }

    private static func flushProse(_ buf: inout [String], into out: inout [MarkdownSegment]) {
        guard !buf.isEmpty else { return }
        let joined = buf.joined(separator: "\n")
        if !joined.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            out.append(.prose(joined))
        }
        buf.removeAll()
    }

    private static func isMermaidOpener(_ s: String) -> Bool {
        // ```mermaid or ~~~mermaid, possibly with a trailing space/comment.
        // We don't care about CommonMark's full grammar — just the common
        // path the web UI emits and a human is likely to type.
        guard s.count >= 10 else { return false }
        let prefix3 = s.prefix(3)
        guard prefix3 == "```" || prefix3 == "~~~" else { return false }
        let rest = s.dropFirst(3).trimmingCharacters(in: .whitespaces)
        return rest.lowercased() == "mermaid"
    }

    private static func isFenceClose(_ s: String) -> Bool {
        s == "```" || s == "~~~"
    }
}

#Preview("Mixed markdown + mermaid") {
    ScrollView {
        MarkdownView(text: """
            ## Auth refactor

            We need to refactor **auth** to support [OAuth](https://oauth.net).

            ```mermaid
            graph TD
              U[User] --> A[App]
              A --> H[Hub]
              H --> DB[(SQLite)]
            ```

            Then add a flow diagram for sign-out:

            ```mermaid
            sequenceDiagram
              participant U as User
              participant A as App
              U->>A: tap "Sign out"
              A->>A: clear keychain
            ```

            Done!
            """)
        .padding()
    }
}
