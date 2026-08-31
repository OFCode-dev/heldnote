// Headless test runner: serves the repo over http, opens tests.html in
// chromium via playwright, waits for the harness summary, exits 1 on failures.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
const MIME = { ".html":"text/html", ".js":"text/javascript", ".mjs":"text/javascript", ".css":"text/css", ".json":"application/json", ".webmanifest":"application/manifest+json", ".png":"image/png", ".svg":"image/svg+xml", ".woff2":"font/woff2" };
const root = process.cwd();
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file = join(root, path === "/" ? "index.html" : path.slice(1));
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404); res.end("not found"); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
let chromium;
try { ({ chromium } = await import("playwright")); }
catch { ({ chromium } = await import("playwright-core")); }
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium-browser", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage();
const consoleLines = [];
page.on("console", m => consoleLines.push(m.text()));
page.on("pageerror", e => consoleLines.push("PAGEERROR: " + e.message));
await page.goto(`http://127.0.0.1:${port}/tests.html`);
try {
  await page.waitForFunction(() => /total/.test(document.getElementById("results")?.textContent || ""), { timeout: 120000 });
} catch {
  console.log("TIMEOUT waiting for results. Console so far:");
  console.log(consoleLines.join("\n"));
  await browser.close(); server.close(); process.exit(2);
}
const text = await page.evaluate(() => document.getElementById("results").innerText);
console.log(text);
const failed = !/ 0 failed,/.test(" " + text.split("\n")[0]);
if (failed) console.log("\nConsole output:\n" + consoleLines.filter(l => l.startsWith("FAIL")).join("\n"));
await browser.close(); server.close();
process.exit(failed ? 1 : 0);
