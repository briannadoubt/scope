// SCP-176..181 — Public marketing + docs site: shared HTML layout helper.
//
// This module is the single place that emits a full HTML document for every
// public page (landing, features, docs). It carries the shared <head> (SEO +
// OpenGraph), the header nav, and the footer so every page is visually and
// structurally consistent. No client JS framework — plain HTML/CSS, with a
// tiny inline <script> for the mobile nav toggle only.
//
// IMPORTANT: this is the CLOUD-ONLY public site. The router that consumes this
// helper is mountable and is only mounted by the server in cloud mode; nothing
// here assumes it is always mounted.

const SITE_NAME = 'Scope';
const SITE_TAGLINE = 'The local-first kanban for engineers and their agents.';
const REPO_URL = 'https://github.com/briannadoubt/scope';

/**
 * Minimal HTML-escape for interpolating untrusted/dynamic text into attributes
 * and text nodes. All page copy in this site is static, but escaping keeps the
 * helper safe to reuse if a value ever becomes dynamic (e.g. opts paths).
 */
export function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render the shared header nav. Links resolve through the caller-provided
 * paths so the same markup works whether the app lives at /app or elsewhere,
 * and whether GitHub login is at /auth/login or a custom path.
 *
 * @param {{ assetPrefix: string, githubLoginPath: string, active?: string }} ctx
 */
function header(ctx) {
  const link = (href, label, key) =>
    `<a class="nav-link${ctx.active === key ? ' active' : ''}" href="${esc(href)}">${esc(label)}</a>`;
  return `
  <header class="site-header">
    <div class="site-header-inner">
      <a class="brand" href="/" aria-label="${esc(SITE_NAME)} home">
        <span class="brand-mark" aria-hidden="true">&#9670;</span>
        <span class="brand-name">${esc(SITE_NAME)}</span>
      </a>
      <button class="nav-toggle" type="button" aria-label="Toggle navigation" aria-expanded="false">
        <span></span><span></span><span></span>
      </button>
      <nav class="site-nav" aria-label="Primary">
        ${link('/features', 'Features', 'features')}
        ${link('/docs', 'Docs', 'docs')}
        <a class="nav-link" href="${esc(REPO_URL)}" rel="noopener">GitHub</a>
        <a class="btn-cta" href="${esc(ctx.githubLoginPath)}">Sign in with GitHub</a>
      </nav>
    </div>
  </header>`;
}

/** Render the shared footer with the GitHub repo link. */
function footer() {
  const year = new Date().getFullYear();
  return `
  <footer class="site-footer">
    <div class="site-footer-inner">
      <div class="footer-brand">
        <span class="brand-mark" aria-hidden="true">&#9670;</span>
        <span>${esc(SITE_NAME)}</span>
      </div>
      <nav class="footer-nav" aria-label="Footer">
        <a href="/features">Features</a>
        <a href="/docs">Docs</a>
        <a href="/docs/getting-started">Getting started</a>
        <a href="${esc(REPO_URL)}" rel="noopener">GitHub</a>
      </nav>
      <p class="footer-copy">&copy; ${year} ${esc(SITE_NAME)} &middot; MIT licensed &middot;
        <a href="${esc(REPO_URL)}" rel="noopener">briannadoubt/scope</a>
      </p>
    </div>
  </footer>`;
}

/**
 * Wrap page-specific body HTML in a complete document.
 *
 * @param {object} opts
 * @param {string} opts.title        - <title> + OpenGraph title.
 * @param {string} opts.description  - meta description + OG description.
 * @param {string} opts.body         - inner HTML for <main>.
 * @param {string} [opts.active]     - nav key to highlight ('features' | 'docs').
 * @param {string} opts.assetPrefix  - URL prefix for static assets (e.g. /site-assets).
 * @param {string} opts.githubLoginPath - URL for the "Sign in with GitHub" button.
 * @param {string} [opts.canonicalPath] - path for the canonical/OG url tag.
 * @returns {string} full HTML document.
 */
export function page(opts) {
  const {
    title,
    description,
    body,
    active = '',
    assetPrefix,
    githubLoginPath,
    canonicalPath = '/',
  } = opts;

  const fullTitle = title === SITE_NAME ? SITE_NAME : `${title} &middot; ${SITE_NAME}`;
  const cssHref = `${assetPrefix}/site.css`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${fullTitle}</title>
  <meta name="description" content="${esc(description)}" />
  <meta name="theme-color" content="#0d1117" />
  <link rel="canonical" href="${esc(canonicalPath)}" />

  <!-- OpenGraph / social cards -->
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="${esc(SITE_NAME)}" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:url" content="${esc(canonicalPath)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(title)}" />
  <meta name="twitter:description" content="${esc(description)}" />

  <link rel="stylesheet" href="${esc(cssHref)}" />
</head>
<body>
${header({ assetPrefix, githubLoginPath, active })}
  <main class="site-main">
${body}
  </main>
${footer()}
  <script>
    // Mobile nav toggle — the only client JS on the site.
    (function () {
      var btn = document.querySelector('.nav-toggle');
      var nav = document.querySelector('.site-nav');
      if (!btn || !nav) return;
      btn.addEventListener('click', function () {
        var open = nav.classList.toggle('open');
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    })();
  </script>
</body>
</html>`;
}

export { SITE_NAME, SITE_TAGLINE, REPO_URL };
