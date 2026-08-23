// Integrity checker for the legal-page cluster.
//
// Runs in Node, not in tests.html: it reads the filesystem, which the browser
// harness cannot do. No dependencies — the repo has no package.json and this
// script must not introduce one.
//
// PAGES is the single source of truth for what must exist. Later locales are
// added here and the checks below apply to them unchanged.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://heldnote.app';

const PAGES = [
  { url: '/terms',      file: 'terms.html',      lang: 'en', canonical: '/terms',   stub: false },
  { url: '/privacy',    file: 'privacy.html',    lang: 'en', canonical: '/privacy', stub: false },
  { url: '/en/terms',   file: 'en/terms.html',   lang: 'en', canonical: '/terms',   stub: true  },
  { url: '/en/privacy', file: 'en/privacy.html', lang: 'en', canonical: '/privacy', stub: true  },
];

// Only locales listed here may appear in an hreflang or a lang attribute.
const LOCALES = ['en'];

const failures = [];
const fail = (msg) => failures.push(msg);

function read(file) {
  const path = join(ROOT, file);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

// Maps a site-absolute URL back to the file that serves it, mirroring how
// GitHub Pages resolves extensionless paths.
function fileForUrl(url) {
  const known = PAGES.find((p) => p.url === url);
  return known ? known.file : `${url.replace(/^\//, '')}.html`;
}

for (const page of PAGES) {
  const html = read(page.file);
  if (html === null) {
    fail(`${page.file}: does not exist`);
    continue;
  }

  const langMatch = html.match(/<html[^>]*\slang="([^"]+)"/);
  if (!langMatch) {
    fail(`${page.file}: <html> has no lang attribute`);
  } else if (langMatch[1] !== page.lang) {
    fail(`${page.file}: lang="${langMatch[1]}", expected "${page.lang}"`);
  } else if (!LOCALES.includes(langMatch[1])) {
    fail(`${page.file}: declares locale "${langMatch[1]}" which is not shipped`);
  }

  const canonical = html.match(/<link[^>]*rel="canonical"[^>]*href="([^"]+)"/);
  const wantCanonical = `${ORIGIN}${page.canonical}`;
  if (!canonical) {
    fail(`${page.file}: no canonical link`);
  } else if (canonical[1] !== wantCanonical) {
    fail(`${page.file}: canonical is ${canonical[1]}, expected ${wantCanonical}`);
  }

  if (page.stub) {
    if (!/<meta[^>]*http-equiv="refresh"[^>]*content="0;\s*url=\/[a-z]+"/.test(html)) {
      fail(`${page.file}: stub has no meta refresh`);
    }
    continue; // stubs carry no hreflang and no body content
  }

  // Every hreflang target must resolve to a real file, and x-default must exist.
  const hreflangs = [...html.matchAll(/<link[^>]*hreflang="([^"]+)"[^>]*href="([^"]+)"/g)];
  if (hreflangs.length === 0) {
    fail(`${page.file}: no hreflang links`);
  }
  const tags = hreflangs.map(([, tag]) => tag);
  if (!tags.includes('x-default')) {
    fail(`${page.file}: no x-default hreflang`);
  }
  for (const [, tag, href] of hreflangs) {
    if (tag !== 'x-default' && !LOCALES.includes(tag)) {
      fail(`${page.file}: hreflang "${tag}" is not a shipped locale`);
    }
    if (!href.startsWith(ORIGIN)) {
      fail(`${page.file}: hreflang href "${href}" is not absolute`);
      continue;
    }
    const target = fileForUrl(href.slice(ORIGIN.length));
    if (!existsSync(join(ROOT, target))) {
      fail(`${page.file}: hreflang "${tag}" points at ${href}, but ${target} does not exist`);
    }
  }
}

// Every indexable page must appear in the sitemap.
const sitemap = read('sitemap.xml');
if (sitemap === null) {
  fail('sitemap.xml: does not exist');
} else {
  for (const page of PAGES) {
    if (page.stub) continue; // stubs are noindex redirects, deliberately absent
    if (!sitemap.includes(`${ORIGIN}${page.url}`)) {
      fail(`sitemap.xml: missing ${ORIGIN}${page.url}`);
    }
  }
}

// Prose pages load no application code, so they need index.html's theme
// bootstrap inlined or they ignore a theme the reader chose in the app and
// follow the OS instead.
for (const page of PAGES) {
  if (page.stub) continue;
  const html = read(page.file);
  if (html && !/localStorage\.getItem\('heldnote-theme'\)/.test(html)) {
    fail(`${page.file}: no theme bootstrap; will ignore the reader's stored theme`);
  }
}

// The app page must link to the policy somewhere a JS-enabled user can see.
// index.html's <noscript> block also links to it, but that serves crawlers
// only — a real visitor never renders it. Strip noscript before checking.
const appPage = read('index.html');
if (appPage === null) {
  fail('index.html: does not exist');
} else {
  const visible = appPage.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  if (!/href="\/privacy"/.test(visible)) {
    fail('index.html: no visible link to /privacy outside <noscript>');
  }
}

if (failures.length > 0) {
  console.error(`legal-links: ${failures.length} failure(s)\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`legal-links: OK (${PAGES.length} pages checked)`);
