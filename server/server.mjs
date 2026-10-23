import http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, copyFile, unlink, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.resolve(process.env.PASSWORD_VAULT_DATA_DIR || path.join(homedir(), ".local/share/password-vault"));
const host = process.env.PASSWORD_VAULT_HOST || "127.0.0.1";
const port = Number(process.env.PASSWORD_VAULT_PORT || 39871);
if (!Number.isInteger(port) || port < 1 || port > 65534) throw new Error("Invalid PASSWORD_VAULT_PORT");
const pairingPort = port + 1;
if (host !== "127.0.0.1" && host !== "::1") {
  throw new Error("Bind only to loopback; use an HTTPS reverse proxy for other devices");
}
process.umask(0o077);
await mkdir(directory, { recursive: true, mode: 0o700 });
const tokenPath = path.join(directory, "access-token");
let token;
try {
  const file = await open(tokenPath, "wx", 0o600);
  token = randomBytes(32).toString("hex");
  try { await file.writeFile(`${token}\n`); } finally { await file.close(); }
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  token = (await readFile(tokenPath, "utf8")).trim();
}
if (!/^[0-9a-f]{64}$/.test(token)) throw new Error("Invalid access-token file");
let tokenBytes = Buffer.from(token, "ascii");
const vaultPath = path.join(directory, "vault.json");
const devicesPath = path.join(directory, "devices.json");
let devices;
try {
  const saved = JSON.parse(await readFile(devicesPath, "utf8"));
  if (saved.version !== 1 || !Array.isArray(saved.devices) ||
      saved.devices.some((device) => !/^[0-9a-f]{24}$/.test(device.id) ||
        !/^[0-9a-f]{64}$/.test(device.tokenHash) || typeof device.name !== "string")) {
    throw new Error("Invalid devices file");
  }
  devices = saved.devices;
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  devices = [];
}
const appRoot = path.resolve(process.env.PASSWORD_VAULT_APP_DIR ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const pages = new Map([
  ["/", ["web/index.html", "text/html; charset=utf-8"]],
  ["/web/app.js", ["web/app.js", "text/javascript; charset=utf-8"]],
  ["/web/style.css", ["web/style.css", "text/css; charset=utf-8"]],
  ["/i18n.js", ["i18n.js", "text/javascript; charset=utf-8"]],
  ["/crypto.js", ["crypto.js", "text/javascript; charset=utf-8"]],
  ["/sync.js", ["sync.js", "text/javascript; charset=utf-8"]]
]);
let queue = Promise.resolve();

function reply(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(body));
}

async function page(request, response, resource) {
  const [relative, contentType] = resource;
  const body = await readFile(path.join(appRoot, relative));
  const localPage = request.headers.host === `127.0.0.1:${port}` ||
    request.headers.host === `localhost:${port}`;
  response.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "Content-Security-Policy": `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'${localPage ? ` http://127.0.0.1:${pairingPort}` : ""}; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(body);
}

function access(request) {
  const match = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.authorization || "");
  if (!match) return null;
  const provided = Buffer.from(match[1], "ascii");
  if (timingSafeEqual(provided, tokenBytes)) return { kind: "admin" };
  const hash = createHash("sha256").update(provided).digest("hex");
  const device = devices.find((item) => timingSafeEqual(
    Buffer.from(item.tokenHash, "hex"), Buffer.from(hash, "hex")));
  return device ? { kind: "device", id: device.id } : null;
}

async function writePrivateFile(destination, value) {
  const temporary = path.join(directory, `private-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  let file;
  try {
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(value);
    await file.sync();
    await file.close();
    file = null;
    await rename(temporary, destination);
  } catch (error) {
    await file?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function snapshots() {
  const names = await readdir(directory);
  const revisions = names.map((name) => /^vault-revision-([1-9]\d*)\.json$/.exec(name))
    .filter(Boolean).map((match) => Number(match[1]))
    .filter(Number.isSafeInteger).sort((a, b) => b - a).slice(0, 50);
  return Promise.all(revisions.map(async (revision) => ({
    revision,
    createdAt: (await stat(path.join(directory, `vault-revision-${revision}.json`))).mtime.toISOString()
  })));
}

function validRecord(record) {
  return record && record.version === 1 && record.kdf === "PBKDF2-SHA-256" &&
    Number.isInteger(record.iterations) && record.iterations >= 250000 && record.iterations <= 2000000 &&
    /^[A-Za-z0-9+/]{22}==$/.test(record.salt) && /^[A-Za-z0-9+/]{16}$/.test(record.iv) &&
    typeof record.ciphertext === "string" && record.ciphertext.length > 20 &&
    record.ciphertext.length <= 2 * 1024 * 1024 && /^[A-Za-z0-9+/]+={0,2}$/.test(record.ciphertext);
}

async function current() {
  try { return JSON.parse(await readFile(vaultPath, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return { revision: 0, record: null }; throw error; }
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024 + 4096) throw new Error("BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function handle(request, response) {
  if (request.method === "GET" && pages.has(request.url)) {
    await page(request, response, pages.get(request.url));
    return;
  }
  const snapshotMatch = /^\/v1\/snapshots\/([1-9]\d*)$/.exec(request.url);
  const deviceMatch = /^\/v1\/devices\/([0-9a-f]{24})$/.exec(request.url);
  const route = request.url === "/v1/vault" && ["GET", "PUT"].includes(request.method) ||
    request.url === "/v1/snapshots" && request.method === "GET" ||
    snapshotMatch && request.method === "GET" ||
    request.url === "/v1/devices" && ["GET", "POST"].includes(request.method) ||
    deviceMatch && request.method === "DELETE" ||
    request.url === "/v1/admin/rotate-token" && request.method === "POST";
  if (!route) {
    reply(response, 404, { error: "not_found" });
    return;
  }
  const permission = access(request);
  if (!permission) {
    reply(response, 401, { error: "unauthorized" });
    return;
  }
  if (request.url !== "/v1/vault" && request.url !== "/v1/snapshots" && !snapshotMatch &&
      permission.kind !== "admin") {
    reply(response, 403, { error: "admin_required" });
    return;
  }
  if (request.url === "/v1/snapshots") {
    reply(response, 200, { snapshots: await snapshots() });
    return;
  }
  if (snapshotMatch) {
    const revision = Number(snapshotMatch[1]);
    if (!Number.isSafeInteger(revision)) return reply(response, 404, { error: "not_found" });
    let saved;
    try { saved = JSON.parse(await readFile(path.join(directory, `vault-revision-${revision}.json`), "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") return reply(response, 404, { error: "not_found" });
      throw error;
    }
    if (saved.revision !== revision || !validRecord(saved.record)) throw new Error("Invalid snapshot");
    reply(response, 200, saved);
    return;
  }
  if (request.url === "/v1/devices") {
    if (request.method === "GET") {
      reply(response, 200, { devices: devices.map(({ id, name, createdAt }) => ({ id, name, createdAt })) });
      return;
    }
    let input;
    try { input = await readBody(request); }
    catch { return reply(response, 400, { error: "invalid_json_or_size" }); }
    const name = String(input?.name || "").trim();
    if (!name || name.length > 60 || /[\x00-\x1f\x7f]/.test(name) || devices.length >= 50) {
      return reply(response, 400, { error: "invalid_device" });
    }
    const deviceToken = randomBytes(32).toString("hex");
    const device = { id: randomBytes(12).toString("hex"), name,
      tokenHash: createHash("sha256").update(deviceToken).digest("hex"),
      createdAt: new Date().toISOString() };
    devices.push(device);
    try { await writePrivateFile(devicesPath, JSON.stringify({ version: 1, devices })); }
    catch (error) { devices.pop(); throw error; }
    reply(response, 201, { device: { id: device.id, name, createdAt: device.createdAt }, token: deviceToken });
    return;
  }
  if (deviceMatch) {
    const index = devices.findIndex((device) => device.id === deviceMatch[1]);
    if (index < 0) return reply(response, 404, { error: "not_found" });
    const [removed] = devices.splice(index, 1);
    try { await writePrivateFile(devicesPath, JSON.stringify({ version: 1, devices })); }
    catch (error) { devices.splice(index, 0, removed); throw error; }
    reply(response, 200, { removed: true });
    return;
  }
  if (request.url === "/v1/admin/rotate-token") {
    const replacement = randomBytes(32).toString("hex");
    await writePrivateFile(tokenPath, `${replacement}\n`);
    token = replacement;
    tokenBytes = Buffer.from(token, "ascii");
    reply(response, 200, { token });
    return;
  }
  if (request.method === "GET") {
    reply(response, 200, await current());
    return;
  }
  let input;
  try { input = await readBody(request); }
  catch { reply(response, 400, { error: "invalid_json_or_size" }); return; }
  if (!Number.isSafeInteger(input?.expectedRevision) || input.expectedRevision < 0 || !validRecord(input.record)) {
    reply(response, 400, { error: "invalid_request" });
    return;
  }
  const existing = await current();
  if (existing.revision !== input.expectedRevision) {
    reply(response, 409, { error: "revision_conflict", revision: existing.revision });
    return;
  }
  const next = { revision: existing.revision + 1, record: input.record };
  const temporary = path.join(directory, `vault-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(next));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    if (existing.revision > 0) {
      const snapshot = path.join(directory, `vault-revision-${existing.revision}.json`);
      await copyFile(vaultPath, snapshot, constants.COPYFILE_EXCL);
    }
    await rename(temporary, vaultPath);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  reply(response, 200, { revision: next.revision });
}

const server = http.createServer((request, response) => {
  const task = queue.then(() => handle(request, response));
  queue = task.catch(() => {});
  task.catch(() => { if (!response.headersSent) reply(response, 500, { error: "server_error" }); });
});
const pairing = http.createServer((request, response) => {
  const localAddress = request.socket.remoteAddress === "127.0.0.1" ||
    request.socket.remoteAddress === "::ffff:127.0.0.1";
  const hostMatches = request.headers.host === `127.0.0.1:${pairingPort}`;
  const origin = request.headers.origin;
  const pageOrigin = `http://127.0.0.1:${port}`;
  const localhostOrigin = `http://localhost:${port}`;
  const permittedOrigin = !origin || origin === pageOrigin || origin === localhostOrigin ||
    /^(chrome-extension|moz-extension):\/\/[^/]+$/.test(origin);
  if (!localAddress || !hostMatches || !permittedOrigin || request.url !== "/v1/local-pair" ||
      request.method !== "POST") {
    reply(response, 404, { error: "not_found" });
    return;
  }
  if (origin === pageOrigin || origin === localhostOrigin) response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  reply(response, 200, { url: pageOrigin, token });
});
server.listen(port, host, () => {
  console.log(`Password Vault sync listening on http://${host}:${port}`);
  console.log(`Access token file: ${tokenPath}`);
});
pairing.listen(pairingPort, "127.0.0.1", () => {
  console.log(`Local pairing listening on 127.0.0.1:${pairingPort}`);
});
