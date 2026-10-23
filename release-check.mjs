import fs from "node:fs";

const files = ["manifest.json", "i18n.js", "crypto.js", "csv.js", "sync.js", "background.js", "content.js", "content.css", "popup.js", "popup.html", "suggest.js", "suggest.html", "web-bridge.js"];
const source = files.map((file) => fs.readFileSync(new URL(file, import.meta.url), "utf8")).join("\n");
const manifest = JSON.parse(fs.readFileSync(new URL("manifest.json", import.meta.url), "utf8"));
for (const file of ["NOTICE.md", "LICENSE", "LUCIDE-LICENSE"]) {
  if (!fs.existsSync(new URL(file, import.meta.url))) throw new Error(`release notice missing: ${file}`);
}

const forbidden = [
  [/XMLHttpRequest/, "XMLHttpRequest"],
  [/WebSocket/, "WebSocket"],
  [/\beval\s*\(/, "eval"],
  [/new\s+Function\s*\(/, "dynamic Function"]
];

for (const [pattern, label] of forbidden) {
  if (pattern.test(source)) throw new Error(`forbidden ${label}`);
}
const background = fs.readFileSync(new URL("background.js", import.meta.url), "utf8");
const web = fs.readFileSync(new URL("web/app.js", import.meta.url), "utf8");
const webHtml = fs.readFileSync(new URL("web/index.html", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("server/server.mjs", import.meta.url), "utf8");
if ((source.match(/\bfetch\s*\(/g) || []).length !== 2 ||
    !/fetch\(`\$\{VaultSync\.endpoint\(url\)\}\/v1\/vault`/.test(background) ||
    !/fetch\(`http:\/\/127\.0\.0\.1:\$\{Number\(parsed\.port\) \+ 1\}\/v1\/local-pair`/.test(background)) {
  throw new Error("network requests must use the validated sync or local pairing endpoint");
}
if (/\beval\s*\(|new\s+Function\s*\(|XMLHttpRequest|WebSocket/.test(web) ||
    (web.match(/\bfetch\s*\(/g) || []).length !== 2 ||
    !/fetch\(resource,/.test(web) ||
    !/if \(!validResource\(resource\)\)/.test(web) ||
    !/fetch\(`http:\/\/127\.0\.0\.1:\$\{Number\(location\.port\) \+ 1\}\/v1\/local-pair`/.test(web) ||
    /<script[^>]+src=["']https?:/i.test(webHtml) ||
    !/script-src 'self'; style-src 'self'; connect-src 'self'/.test(server) ||
    !/pairing\.listen\(pairingPort, "127\.0\.0\.1"/.test(server)) {
  throw new Error("web vault must use local scripts, the same-origin vault API, and a restrictive CSP");
}

const allowedPermissions = new Set(["storage", "clipboardWrite", "alarms", "contextMenus"]);
const unexpected = (manifest.permissions || []).filter((permission) => !allowedPermissions.has(permission));
if (unexpected.length) throw new Error(`unexpected permissions: ${unexpected.join(", ")}`);
if (manifest.content_security_policy?.extension_pages !== "script-src 'self'; object-src 'self'") {
  throw new Error("extension CSP is missing or too broad");
}
if (manifest.author !== "kangshifuSteven" ||
    manifest.homepage_url !== "https://github.com/kangshifuSteven/password-vault" ||
    !manifest.content_scripts?.[0]?.css?.includes("content.css")) {
  throw new Error("author metadata or packaged content stylesheet is missing");
}
if (/password\s*:\s*["'`][^"'`]+["'`]/i.test(source)) {
  throw new Error("possible hard-coded password literal");
}

console.log("release check passed: validated sync endpoint, no remote code or hard-coded password detected");
