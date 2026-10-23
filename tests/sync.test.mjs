import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { webcrypto } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = await mkdtemp(path.join(tmpdir(), "password-vault-sync-test-"));
const probe = net.createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const server = spawn(process.execPath, [path.join(root, "server/server.mjs")], {
  env: { ...process.env, PASSWORD_VAULT_DATA_DIR: directory, PASSWORD_VAULT_PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"]
});
const url = `http://127.0.0.1:${port}`;
let serverErrors = "";
server.stderr.on("data", (chunk) => { serverErrors += chunk.toString(); });

async function waitForToken() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(serverErrors || "Server exited");
    try {
      const value = (await readFile(path.join(directory, "access-token"), "utf8")).trim();
      const response = await fetch(`${url}/v1/vault`, { headers: { Authorization: `Bearer ${value}` } });
      if (response.ok) return value;
    } catch { /* Wait for listener. */ }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(serverErrors || "Server did not start");
}

function area() {
  const values = {};
  return {
    async get(keys) {
      if (keys == null) return { ...values };
      const names = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(names.filter((key) => key in values).map((key) => [key, values[key]]));
    },
    async set(next) { Object.assign(values, next); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; },
    async setAccessLevel() {}
  };
}

async function client() {
  let alarmListener;
  const scheduled = [];
  const chrome = {
    storage: { local: area(), session: area() },
    alarms: { create: async (name, options) => { scheduled.push({ name, options }); },
      clear: async () => {}, onAlarm: { addListener(listener) { alarmListener = listener; } } },
    runtime: { id: "test-extension", getURL: () => "chrome-extension://test-extension/",
      getManifest: () => ({ version: "0.1.0" }), onMessage: { addListener() {} } },
    contextMenus: {}
  };
  const context = vm.createContext({ chrome, crypto: webcrypto, fetch, AbortController, URL,
    TextEncoder, TextDecoder, atob, btoa, setTimeout, clearTimeout, console });
  context.importScripts = (...files) => {
    for (const file of files) vm.runInContext(context.sources[file], context, { filename: file });
  };
  context.sources = {
    "crypto.js": await readFile(path.join(root, "crypto.js"), "utf8"),
    "sync.js": await readFile(path.join(root, "sync.js"), "utf8")
  };
  vm.runInContext(await readFile(path.join(root, "background.js"), "utf8"), context, { filename: "background.js" });
  const handle = vm.runInContext("handleMessage", context);
  const sender = { id: "test-extension", url: "chrome-extension://test-extension/popup.html" };
  const send = (message, source = sender) => handle(message, source);
  send.fireAlarm = (name) => alarmListener({ name });
  send.scheduled = scheduled;
  send.localStorage = chrome.storage.local;
  send.crypto = vm.runInContext("PasswordCrypto", context);
  return send;
}

try {
  const token = await waitForToken();
  const pairUrl = `http://127.0.0.1:${port + 1}/v1/local-pair`;
  const localPair = await fetch(pairUrl, { method: "POST", headers: { Origin: url } });
  assert.equal(localPair.status, 200);
  assert.deepEqual(await localPair.json(), { url, token });
  const localhostPair = await fetch(pairUrl, { method: "POST",
    headers: { Origin: `http://localhost:${port}` } });
  assert.equal(localhostPair.status, 200);
  assert.equal(localhostPair.headers.get("access-control-allow-origin"), `http://localhost:${port}`);
  assert.equal((await fetch(pairUrl, { method: "POST",
    headers: { Origin: "https://other.example" } })).status, 404);
  assert.equal((await fetch(`${url}/v1/local-pair`, { method: "POST" })).status, 404);
  assert.equal((await fetch(`${url}/v1/vault`)).status, 401);
  assert.equal((await fetch(`${url}/v1/vault`, { headers: { Authorization: "Bearer " + "0".repeat(64) } })).status, 401);
  const a = await client();
  const b = await client();
  const minimumClient = await client();
  await assert.rejects(() => minimumClient({ type: "setup", password: "elevenchars" }), /至少需要 12/);
  await minimumClient({ type: "setup", password: "twelve chars" });
  assert.equal((await minimumClient({ type: "getState" })).mode, "unlocked");
  assert.equal(minimumClient.crypto.siteUrl("example.com"), "https://example.com/");
  assert.equal(minimumClient.crypto.siteUrl(""), "");
  await a.localStorage.set({ localSyncUrl: url });
  for (const address of ["http://example.com", "https://user:pass@example.com", "https://example.com/path"]) {
    await assert.rejects(() => a({ type: "configureSync", url: address, token: "0".repeat(64) }));
  }
  const password = "long master passphrase for tests";
  await a({ type: "setup", password });
  assert.equal((await a({ type: "exportVault" })).record.iterations, 600000);
  const first = (await a({ type: "saveEntry", entry: { name: "first", site: "first.example",
    username: "alice", password: "secret-first" } })).entry;
  await a.fireAlarm("local-vault-auto-sync");
  assert.equal((await a({ type: "getSyncState" })).revision, 1);
  assert.equal((await b({ type: "bootstrapSync", url, token, password })).count, 1);
  assert.equal((await b({ type: "list" })).entries[0].password, "secret-first");
  await b({ type: "disconnectSync" });
  assert.equal((await b({ type: "getSyncState" })).autoConnect, false);
  assert.equal((await b({ type: "connectLocal", url })).connected, true);
  const localPage = { id: "test-extension", frameId: 0, url: `${url}/`, tab: { id: 21, url: `${url}/` } };
  const sharedState = await a({ type: "sharedState" }, localPage);
  assert.equal(sharedState.available, true);
  assert.equal(sharedState.unlocked, true);
  const sharedAccess = await a({ type: "sharedAccess" }, localPage);
  assert.equal(sharedAccess.available, true);
  assert.equal(sharedAccess.unlocked, true);
  await a({ type: "sharedLock" }, localPage);
  assert.equal((await a({ type: "getState" })).mode, "locked");
  assert.equal((await a({ type: "sharedUnlock", password }, localPage)).unlocked, true);

  await a({ type: "saveEntry", entry: { name: "second", site: "second.example",
    username: "alice", password: "secret-second" } });
  await b({ type: "saveEntry", entry: { name: "third", site: "third.example",
    username: "bob", password: "secret-third" } });
  assert.equal((await a({ type: "syncNow" })).status, "uploaded");
  assert.equal((await b({ type: "syncNow" })).status, "merged");
  assert.equal((await a({ type: "syncNow" })).status, "downloaded");
  assert.equal((await a({ type: "list" })).entries.length, 3);

  await a({ type: "saveEntry", entry: { ...first, password: "secret-local" } });
  await b({ type: "saveEntry", entry: { ...first, password: "secret-remote" } });
  assert.equal((await a({ type: "syncNow" })).status, "uploaded");
  const conflict = await b({ type: "syncNow" });
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.conflicts[0].id, first.id);
  assert.equal((await b({ type: "syncNow", decisions: { [first.id]: "both" } })).status, "merged");
  await a({ type: "syncNow" });
  const passwords = (await a({ type: "list" })).entries.map((entry) => entry.password);
  assert(passwords.includes("secret-local") && passwords.includes("secret-remote"));

  const bEntries = (await b({ type: "list" })).entries;
  const second = bEntries.find((entry) => entry.site === "second.example");
  await a({ type: "deleteEntry", id: second.id });
  await b({ type: "saveEntry", entry: { ...second, password: "changed-while-deleted" } });
  assert.equal((await a({ type: "syncNow" })).status, "uploaded");
  const deletion = await b({ type: "syncNow" });
  assert.equal(deletion.status, "conflict");
  assert.equal(deletion.conflicts[0].id, second.id);
  assert.equal((await b({ type: "syncNow", decisions: { [second.id]: "remote" } })).status, "downloaded");
  assert(!(await b({ type: "list" })).entries.some((entry) => entry.id === second.id));

  const rotating = (await a({ type: "saveEntry", entry: { name: "rotation", site: "rotate.example",
    username: "alice", password: "old-rotation" } })).entry;
  assert(a.scheduled.some((alarm) => alarm.name === "local-vault-auto-sync"));
  assert.equal((await a({ type: "getSyncState" })).status.kind, "pending");
  const page = (pathname) => ({ id: "test-extension", frameId: 0,
    url: `https://rotate.example${pathname}`, tab: { id: 7, url: `https://rotate.example${pathname}` } });
  await a({ type: "stageLogin", kind: "change", username: "unrelated-field", currentPassword: "old-rotation",
    password: "new-rotation" }, page("/settings/password"));
  assert.deepEqual((await a({ type: "getPendingLogin" }, page("/settings/password"))).pending?.username, "alice");
  assert.equal((await a({ type: "getPendingLogin" }, page("/settings/done"))).updated, true);
  assert.equal((await a({ type: "list" })).entries.find((entry) => entry.id === rotating.id).password, "new-rotation");

  await a({ type: "stageLogin", kind: "login", remember: true, username: "alice",
    password: "remembered-rotation" }, page("/login"));
  assert.equal((await a({ type: "getPendingLogin" }, page("/account"))).updated, true);
  assert.equal((await a({ type: "list" })).entries.find((entry) => entry.id === rotating.id).password, "remembered-rotation");
  await a({ type: "stageLogin", kind: "login", remember: true, username: "bob",
    password: "new-remembered-account" }, page("/login"));
  assert.equal((await a({ type: "getPendingLogin" }, page("/account"))).updated, false);
  assert.equal((await a({ type: "list" })).entries.find((entry) => entry.username === "bob" &&
    entry.site === "rotate.example").password, "new-remembered-account");
  const beforeDuplicate = (await a({ type: "list" })).entries.length;
  assert.equal((await a({ type: "saveEntry", entry: { name: "rotate.example", site: "rotate.example",
    username: "bob", password: "new-remembered-account" } })).unchanged, true);
  assert.equal((await a({ type: "list" })).entries.length, beforeDuplicate);
  await a.fireAlarm("local-vault-auto-sync");
  assert.equal((await a({ type: "getSyncState" })).status.kind, "ok");
  await b({ type: "syncNow" });
  assert.equal((await b({ type: "list" })).entries.find((entry) => entry.id === rotating.id).password, "remembered-rotation");
  assert.equal((await b({ type: "list" })).entries.find((entry) => entry.username === "bob" &&
    entry.site === "rotate.example").password, "new-remembered-account");

  const freshPage = (pathname) => ({ id: "test-extension", frameId: 0,
    url: `https://fresh.example${pathname}`, tab: { id: 9, url: `https://fresh.example${pathname}` } });
  await a({ type: "stageLogin", kind: "login", username: "new-user",
    password: "new-site-password" }, freshPage("/login"));
  assert.equal((await a({ type: "getPendingLogin" }, freshPage("/dashboard"))).saved, true);
  await a.fireAlarm("local-vault-auto-sync");
  await b({ type: "syncNow" });
  assert.equal((await b({ type: "list" })).entries.find((entry) => entry.site === "fresh.example")?.password,
    "new-site-password");

  await a({ type: "stageLogin", kind: "login", username: "alice", password: "manual-rotation" }, page("/login"));
  const pending = (await a({ type: "getPendingLogin" }, page("/login"))).pending;
  assert.equal(pending.action, "update");
  assert.equal((await a({ type: "list" })).entries.find((entry) => entry.id === rotating.id).password, "remembered-rotation");
  await a({ type: "discardPendingLogin", token: pending.token }, page("/account"));
  await a({ type: "stageLogin", kind: "change", username: "alice",
    currentPassword: "remembered-rotation", password: "wrong-candidate" }, page("/settings/password"));
  assert.equal((await a({ type: "getPendingLogin", failureEvidence: true }, page("/settings/error"))).pending, null);
  assert.equal((await a({ type: "list" })).entries.find((entry) => entry.id === rotating.id).password,
    "remembered-rotation");
  const single = (await a({ type: "saveEntry", entry: { name: "single", site: "single.example",
    username: "one", password: "prior-single" } })).entry;
  const singlePage = (pathname) => ({ id: "test-extension", frameId: 0,
    url: `https://single.example${pathname}`, tab: { id: 8, url: `https://single.example${pathname}` } });
  await a({ type: "stageLogin", kind: "change", password: "changed-single" }, singlePage("/password"));
  assert.equal((await a({ type: "getPendingLogin" }, singlePage("/done"))).updated, true);
  assert.equal((await a({ type: "list" })).entries.find((entry) => entry.id === single.id).password, "changed-single");

  const disk = await readFile(path.join(directory, "vault.json"), "utf8");
  assert(!disk.includes("secret-local") && !disk.includes("secret-remote"));
  const files = await readdir(directory);
  assert(files.some((name) => name.startsWith("vault-revision-")));
  const stored = await fetch(`${url}/v1/vault`, { headers: { Authorization: `Bearer ${token}` } });
  const revision = (await stored.json()).revision;
  const stale = await fetch(`${url}/v1/vault`, { method: "PUT", headers: {
    Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expectedRevision: 0, record: (await a({ type: "exportVault" })).record }) });
  assert.equal(stale.status, 409);
  assert(revision >= 5);
  const portableRemote = await client();
  assert.equal((await portableRemote({ type: "openPortableRemote", url, token,
    password })).ephemeral, true);
  assert((await portableRemote({ type: "list" })).entries.length > 0);
  assert.deepEqual(await portableRemote.localStorage.get(null), {});
  await assert.rejects(() => portableRemote({ type: "saveEntry", entry: {
    name: "Do not save", site: "portable.example", username: "test", password: "secret"
  } }), /临时模式仅供查看和填充/);
  assert.deepEqual(await portableRemote.localStorage.get(null), {});
  await portableRemote({ type: "lock" });
  await assert.rejects(() => portableRemote({ type: "list" }), /LOCKED/);
  await assert.rejects(() => portableRemote({ type: "openPortableRemote",
    url: "http://example.com", token, password }), /HTTPS/);
  const c = await client();
  await c({ type: "bootstrapSync", url, token, password });
  const recovery = await c({ type: "exportRecovery" });
  assert.equal(recovery.record.version, 2);
  assert.equal(recovery.record.scheme, "RSA-OAEP-3072+AES-256-GCM");
  assert(!JSON.stringify(recovery.record).includes(recovery.privateKey.pkcs8));
  const otherRecovery = await c({ type: "exportRecovery" });
  await assert.rejects(() => c({ type: "restoreRecovery", record: recovery.record,
    privateKey: otherRecovery.privateKey, newPassword: "new master password after recovery" }),
  /恢复私钥/);
  const portable = await client();
  await portable({ type: "importVault", record: recovery.record, privateKey: recovery.privateKey });
  assert((await portable({ type: "list" })).entries.length > 0);
  await assert.rejects(() => portable({ type: "saveEntry", entry: { name: "portable", site: "portable.example",
    username: "test", password: "portable-secret" } }), /临时模式仅供查看和填充/);
  assert.deepEqual(await portable.localStorage.get(null), {});
  assert.equal((await portable({ type: "exportVault" })).record.version, 2);
  await c({ type: "restoreRecovery", record: recovery.record, privateKey: recovery.privateKey,
    newPassword: "new master password after recovery" });
  assert.equal((await c({ type: "exportVault" })).record.iterations, 600000);
  const legacyClient = await client();
  const legacySalt = webcrypto.getRandomValues(new Uint8Array(16));
  const legacyKey = await legacyClient.crypto.deriveKey("older recovery password", legacySalt, 250000);
  const legacyEncrypted = await legacyClient.crypto.encryptWithKey(legacyKey,
    { version: 1, entries: [{ id: "legacy", name: "Legacy", site: "legacy.example",
      username: "test", password: "legacy-secret" }] });
  const legacyRecord = { version: 1, kdf: "PBKDF2-SHA-256", iterations: 250000,
    salt: Buffer.from(legacySalt).toString("base64"), ...legacyEncrypted };
  await legacyClient({ type: "restoreRecovery", record: legacyRecord,
    password: "older recovery password", newPassword: "new legacy master password" });
  assert.equal((await legacyClient({ type: "exportVault" })).record.iterations, 600000);
  assert.equal((await c({ type: "getSyncState" })).connected, false);
  assert.equal((await c({ type: "replaceRemoteAfterRecovery", url, token })).connected, true);
  await assert.rejects(() => a({ type: "syncNow" }), /同一保险库/);
  const d = await client();
  assert((await d({ type: "bootstrapSync", url, token, password: "new master password after recovery" })).count > 0);
  const e = await client();
  await e({ type: "setup", password: "different local master password" });
  await e({ type: "saveEntry", entry: { name: "local only", site: "local.example",
    username: "eve", password: "local-secret" } });
  assert.equal((await e({ type: "connectLocal", url })).needsMerge, true);
  await assert.rejects(() => e({ type: "previewServerMerge", url,
    password: "wrong password" }), /主密码不正确/);
  const preview = await e({ type: "previewServerMerge", url,
    password: "new master password after recovery" });
  assert.equal(preview.added, 1);
  const joined = await e({ type: "applyServerMerge", url,
    password: "new master password after recovery", expectedRevision: preview.revision });
  assert.equal(joined.connected, true);
  assert((await e({ type: "list" })).entries.some((entry) => entry.site === "local.example"));
  assert((await e({ type: "list" })).entries.some((entry) => entry.site === "first.example"));
  await e({ type: "lock" });
  await assert.rejects(() => e({ type: "unlock", password: "different local master password" }));
  await e({ type: "unlock", password: "new master password after recovery" });

  const adminHeaders = { Authorization: `Bearer ${token}` };
  const createDevice = await fetch(`${url}/v1/devices`, { method: "POST",
    headers: { ...adminHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Phone" }) });
  assert.equal(createDevice.status, 201);
  const issued = await createDevice.json();
  assert.equal((await fetch(`${url}/v1/vault`, {
    headers: { Authorization: `Bearer ${issued.token}` } })).status, 200);
  assert.equal((await fetch(`${url}/v1/devices`, {
    headers: { Authorization: `Bearer ${issued.token}` } })).status, 403);
  assert(!(await readFile(path.join(directory, "devices.json"), "utf8")).includes(issued.token));
  const history = await fetch(`${url}/v1/snapshots`, { headers: adminHeaders });
  assert.equal(history.status, 200);
  const snapshots = (await history.json()).snapshots;
  assert(snapshots.length > 0);
  assert.equal((await fetch(`${url}/v1/snapshots/${snapshots[0].revision}`, {
    headers: adminHeaders })).status, 200);
  assert.equal((await fetch(`${url}/v1/devices/${issued.device.id}`, {
    method: "DELETE", headers: adminHeaders })).status, 200);
  assert.equal((await fetch(`${url}/v1/vault`, {
    headers: { Authorization: `Bearer ${issued.token}` } })).status, 401);
  const rotation = await fetch(`${url}/v1/admin/rotate-token`, {
    method: "POST", headers: adminHeaders });
  assert.equal(rotation.status, 200);
  const newToken = (await rotation.json()).token;
  assert.notEqual(newToken, token);
  assert.equal((await fetch(`${url}/v1/vault`, { headers: adminHeaders })).status, 401);
  assert.equal((await e({ type: "syncNow" })).status, "unchanged");
  assert.equal((await e({ type: "getSyncState" })).status.kind, "ok");
  console.log("Sync test passed: merge onboarding, device revocation, token rotation, history, encryption, CAS.");
} finally {
  server.kill();
  await new Promise((resolve) => server.once("exit", resolve));
  if (path.basename(directory).startsWith("password-vault-sync-test-") &&
      path.dirname(directory) === tmpdir()) await rm(directory, { recursive: true, force: true });
}
