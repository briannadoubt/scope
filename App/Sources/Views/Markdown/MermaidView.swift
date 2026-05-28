import SwiftUI
import WebKit

/// Renders a single Mermaid diagram inside a `WKWebView`, with the same
/// pinned `mermaid@11` build the web UI uses (jsdelivr CDN, strict security,
/// dark theme).
///
/// The view auto-sizes vertically to its rendered content: a small JS shim
/// inside the page measures the SVG's bounding box after `mermaid.render`
/// completes and posts the height back via `WKScriptMessageHandler`. The
/// SwiftUI side then drives a `@State` height that the surrounding layout
/// uses, so the diagram never gets clipped or stretched.
///
/// If mermaid fails to load (offline, CDN flake, bad source) the parent
/// `MarkdownView` keeps the source in a fallback code block — this view just
/// stays at its placeholder height until either render or timeout.
struct MermaidView: View {
    let source: String

    @State private var measuredHeight: CGFloat = 60
    @State private var didFail: Bool = false

    var body: some View {
        if didFail {
            FallbackCodeBlock(source: source, note: "mermaid (offline — showing source)")
        } else {
            MermaidWebView(
                source: source,
                onHeight: { h in measuredHeight = max(60, h) },
                onFail:   { didFail = true }
            )
            .frame(height: measuredHeight)
            .background(Color(uiColor: .secondarySystemBackground),
                        in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .accessibilityLabel("Mermaid diagram")
        }
    }
}

// MARK: - UIViewRepresentable bridge

private struct MermaidWebView: UIViewRepresentable {
    let source: String
    let onHeight: (CGFloat) -> Void
    let onFail: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onHeight: onHeight, onFail: onFail)
    }

    func makeUIView(context: Context) -> WKWebView {
        let userContent = WKUserContentController()
        // Two message channels: one carries the rendered SVG's height
        // (success path), the other tells us mermaid couldn't load (failure
        // path → SwiftUI flips to the code-block fallback).
        userContent.add(context.coordinator, name: "height")
        userContent.add(context.coordinator, name: "fail")

        let cfg = WKWebViewConfiguration()
        cfg.userContentController = userContent
        cfg.defaultWebpagePreferences.allowsContentJavaScript = true

        let web = WKWebView(frame: .zero, configuration: cfg)
        web.scrollView.isScrollEnabled = false
        web.isOpaque = false
        web.backgroundColor = .clear
        web.scrollView.backgroundColor = .clear
        web.scrollView.bounces = false
        // Defer initial render to updateUIView so we can rebuild the HTML
        // whenever `source` changes (e.g. user edits the description).
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        web.loadHTMLString(html(for: source), baseURL: URL(string: "https://localhost/"))
    }

    static func dismantleUIView(_ web: WKWebView, coordinator: Coordinator) {
        web.configuration.userContentController.removeScriptMessageHandler(forName: "height")
        web.configuration.userContentController.removeScriptMessageHandler(forName: "fail")
    }

    // MARK: HTML template

    private func html(for src: String) -> String {
        // JSON-encode the diagram source to dodge quoting/newline pitfalls —
        // mermaid grammars include both `"` and `\n` happily.
        let encoded = (try? String(
            data: JSONSerialization.data(withJSONObject: [src]),
            encoding: .utf8
        )) ?? "[\"\"]"
        // Strip the JSON array wrapping back to a single quoted string literal.
        let literal = String(encoded.dropFirst().dropLast())

        return """
        <!doctype html>
        <html><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <style>
          html, body { margin: 0; padding: 0; background: transparent; }
          body { font-family: -apple-system, system-ui, sans-serif; color: #eee; }
          #d { padding: 8px; }
          #d svg { max-width: 100%; height: auto; display: block; }
          #fallback { padding: 10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
                      font-size: 12px; white-space: pre-wrap; color: #aaa; }
        </style>
        </head><body>
          <div id="d"></div>
          <script type="module">
            const post = (name, body) => {
              try { window.webkit.messageHandlers[name].postMessage(body); } catch {}
            };
            const src = \(literal);
            const reportHeight = () => {
              const r = document.getElementById('d').getBoundingClientRect();
              post('height', Math.ceil(r.height) + 8);
            };
            try {
              const mod = await import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs');
              const mermaid = mod.default;
              mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' });
              const { svg } = await mermaid.render('mmd', src);
              document.getElementById('d').innerHTML = svg;
              // SVG layout is sync once injected, but give Safari a tick.
              requestAnimationFrame(reportHeight);
              new ResizeObserver(reportHeight).observe(document.getElementById('d'));
            } catch (err) {
              post('fail', String(err && err.message || err));
            }
            // Failsafe: if mermaid never loads (CDN unreachable) within 8s,
            // fall back. Mirrors the web UI's 8-second timeout.
            setTimeout(() => {
              if (!document.querySelector('#d svg')) post('fail', 'mermaid load timeout');
            }, 8000);
          </script>
        </body></html>
        """
    }

    // MARK: Coordinator

    final class Coordinator: NSObject, WKScriptMessageHandler {
        let onHeight: (CGFloat) -> Void
        let onFail: () -> Void

        init(onHeight: @escaping (CGFloat) -> Void, onFail: @escaping () -> Void) {
            self.onHeight = onHeight
            self.onFail = onFail
        }

        func userContentController(_ uc: WKUserContentController, didReceive msg: WKScriptMessage) {
            switch msg.name {
            case "height":
                let value: CGFloat
                if let n = msg.body as? NSNumber { value = CGFloat(truncating: n) }
                else if let s = msg.body as? String, let d = Double(s) { value = CGFloat(d) }
                else { return }
                DispatchQueue.main.async { self.onHeight(value) }
            case "fail":
                DispatchQueue.main.async { self.onFail() }
            default:
                break
            }
        }
    }
}

// MARK: - Fallback code block (used when mermaid can't render)

struct FallbackCodeBlock: View {
    let source: String
    let note: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let note {
                Text(note)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Text(source)
                .font(.system(.footnote, design: .monospaced))
                .foregroundStyle(.primary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(Color(uiColor: .secondarySystemBackground),
                            in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .textSelection(.enabled)
        }
    }
}

#Preview("Mermaid diagram") {
    MermaidView(source: """
        graph TD
          A[Start] --> B{Decision?}
          B -- Yes --> C[Do thing]
          B -- No  --> D[Don't]
        """)
    .padding()
}
