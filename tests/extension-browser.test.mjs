import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profile = await mkdtemp(path.join(tmpdir(), "password-vault-extension-test-"));
const directory = await mkdtemp(path.join(tmpdir(), "password-vault-extension-server-test-"));
let context;
let server;
let loginServer;

try {
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    executablePath: process.env.CHROME_PATH || undefined,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`chrome-extension://${id}/popup.html`);
  await page.setViewportSize({ width: 100, height: 600 });
  assert.equal(await page.locator("body").evaluate((body) => Math.round(body.getBoundingClientRect().width)), 380);
  await page.setViewportSize({ width: 380, height: 620 });
  assert.equal(await page.locator(".language-control .sr-only").evaluate((element) =>
    Math.round(element.getBoundingClientRect().width)), 1);
  await page.locator("#languageSelect").selectOption("en");
  assert.equal(await page.locator("h1").textContent(), "Password Vault");
  await page.locator("#languageSelect").selectOption("zh-CN");
  assert.equal(await page.locator("h1").textContent(), "密码匣");
  const state = await page.evaluate(() => browser.runtime.sendMessage({ type: "getState" }));
  assert.equal(state.mode, "setup");
  assert.equal(state.extensionVersion, "0.1.0");
  assert.equal(await page.locator("#accessModeSwitch").isVisible(), true);
  await page.locator("#portableModeButton").click();
  assert.equal(await page.locator("#portableView").isVisible(), true);
  assert.equal(await page.locator("#setupView").isVisible(), false);
  await page.screenshot({ path: path.join(tmpdir(), "password-vault-0.1-portable-file.png") });
  await page.locator('input[name="portableSource"][value="server"]').check();
  assert.equal(await page.locator("#portableRemoteForm").isVisible(), true);
  await page.screenshot({ path: path.join(tmpdir(), "password-vault-0.1-portable-server.png") });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await page.locator("#localModeButton").click();
  assert.equal(await page.locator("#setupView").isVisible(), true);
  assert.equal(await page.locator("#setupPassword").getAttribute("minlength"), "12");
  await page.evaluate(() => browser.storage.local.set({ syncAutoConnect: false }));
  await page.locator("#setupPassword").fill("long master password for extension test");
  await page.locator("#setupConfirm").fill("long master password for extension test");
  await page.locator("#setupForm button[type=submit]").click();
  await page.locator("#firstRunGuide").waitFor({ state: "visible" });
  await page.screenshot({ path: path.join(tmpdir(), "password-vault-0.1-first-run.png") });
  assert.match(await page.locator("#guideTitle").textContent(), /恢复备份/);
  await page.locator("#guideButton").click();
  assert.equal(await page.locator("#guideDialog").isVisible(), true);
  assert.doesNotMatch(await page.locator("#guideDialog").textContent(), /下载密文|同步密文|密文副本/);
  assert.equal(await page.locator("#exportServerVault").textContent(), "导出密码文件");
  await page.locator("#guideClose").click();
  await page.locator("#confirmBackup").click();
  await page.locator("#recoveryKeyPanel").waitFor({ state: "visible" });
  assert.equal(await page.locator("#savedPrivateKey").isDisabled(), true);
  assert.equal(await page.locator("#downloadRecovery").isDisabled(), true);
  const privateDownload = page.waitForEvent("download");
  await page.locator("#downloadPrivateKey").click();
  const privateKey = JSON.parse(await readFile(await (await privateDownload).path(), "utf8"));
  assert.equal(privateKey.kind, "password-vault-recovery-private-key");
  await page.locator("#savedPrivateKey").check();
  const recoveryDownload = page.waitForEvent("download");
  await page.locator("#downloadRecovery").click();
  const recoveryRecord = JSON.parse(await readFile(await (await recoveryDownload).path(), "utf8"));
  assert.equal(recoveryRecord.version, 2);
  assert(!JSON.stringify(recoveryRecord).includes(privateKey.pkcs8));
  assert.equal(await page.evaluate(async ({ key, record }) =>
    (await PasswordCrypto.openRecoveryRecord(key, record)).value.entries.length,
  { key: privateKey, record: recoveryRecord }), 0);
  await page.locator("#cancelBackup").click();
  await page.locator("#guideNext").click();
  assert.match(await page.locator("#guideTitle").textContent(), /账号/);
  await page.locator("#guideNext").click();
  assert.match(await page.locator("#guideTitle").textContent(), /同步/);
  await page.locator("#guideNext").click();
  assert.equal(await page.locator("#firstRunGuide").isVisible(), false);
  await page.reload();
  assert.equal(await page.locator("#firstRunGuide").isVisible(), false);
  const saved = await page.evaluate(() => browser.runtime.sendMessage({
    type: "saveEntry", entry: { name: "Example", site: "example.com", username: "alice",
      password: "extension-secret-test" }
  }));
  assert.equal(saved.entry.site, "example.com");
  await page.reload();
  await page.locator("#entryList .entry-card").first().waitFor({ state: "visible" });
  assert.equal(await page.locator("#entryList .entry-card button").filter({ hasText: "打开网站" }).count(), 1);
  await context.route("https://example.com/**", (route) => route.fulfill({ status: 200, body: "Opened" }));
  const openedPage = context.waitForEvent("page");
  await page.locator("#entryList .entry-card button").filter({ hasText: "打开网站" }).click();
  const opened = await openedPage;
  await opened.waitForLoadState();
  assert.equal(opened.url(), "https://example.com/");
  await opened.close();
  await context.unroute("https://example.com/**");
  await page.screenshot({ path: path.join(tmpdir(), "password-vault-0.1-popup-accounts.png"),
    clip: { x: 0, y: 0, width: 380, height: 430 } });
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(root, "server/server.mjs")], {
    env: { ...process.env, PASSWORD_VAULT_DATA_DIR: directory, PASSWORD_VAULT_PORT: String(port) },
    stdio: "ignore"
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`${url}/v1/vault`);
      if (response.status === 401) break;
    } catch { /* Wait for server. */ }
    if (attempt === 99) throw new Error("Test server did not start");
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  const connected = await page.evaluate((address) => browser.runtime.sendMessage({
    type: "connectLocal", url: address
  }), url);
  assert.equal(connected.connected, true, connected.error);
  const token = (await readFile(path.join(directory, "access-token"), "utf8")).trim();
  const remote = await fetch(`${url}/v1/vault`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal((await remote.json()).revision, 1);
  const stored = await page.evaluate(() => browser.storage.local.get("vaultRecord"));
  assert(!JSON.stringify(stored).includes("extension-secret-test"));
  const vaultFile = (await page.evaluate(() => browser.runtime.sendMessage({ type: "exportVault" }))).record;
  await page.evaluate(() => browser.runtime.sendMessage({ type: "lock" }));
  await page.reload();
  await page.locator("#portableModeButton").click();
  await page.locator("#ephemeralFile").setInputFiles({ name: "vault.json",
    mimeType: "application/json", buffer: Buffer.from(JSON.stringify(vaultFile)) });
  await page.locator("#ephemeralPassword").fill("long master password for extension test");
  await page.locator("#ephemeralForm button[type=submit]").click();
  await page.locator("#entryList .entry-card").first().waitFor({ state: "visible" });
  assert.equal((await page.evaluate(() => browser.runtime.sendMessage({ type: "getState" }))).ephemeral, true);
  assert.equal(await page.locator("#entryList .entry-card button").filter({ hasText: "编辑" }).count(), 0);
  assert.deepEqual(await page.evaluate(() => browser.storage.local.get("vaultRecord")), stored);
  await page.evaluate(() => browser.runtime.sendMessage({ type: "lock" }));
  await page.reload();
  await page.locator("#portableModeButton").click();
  await page.locator('input[name="portableSource"][value="server"]').check();
  await page.locator("#portableRemoteUrl").fill(url);
  await page.locator("#portableRemoteToken").fill(token);
  await page.locator("#portableRemotePassword").fill("long master password for extension test");
  await page.locator("#portableRemoteForm button[type=submit]").click();
  await page.locator("#entryList .entry-card").first().waitFor({ state: "visible" });
  assert.equal((await page.evaluate(() => browser.runtime.sendMessage({ type: "getState" }))).ephemeral, true);
  assert.deepEqual(await page.evaluate(() => browser.storage.local.get("vaultRecord")), stored);
  await page.evaluate(() => browser.runtime.sendMessage({ type: "lock" }));
  await page.reload();
  await page.locator("#unlockPassword").fill("long master password for extension test");
  await page.locator("#unlockForm button[type=submit]").click();
  await page.locator("#entryList .entry-card").first().waitFor({ state: "visible" });
  const vaultPage = await context.newPage();
  const vaultErrors = [];
  vaultPage.on("pageerror", (error) => vaultErrors.push(error.message));
  await vaultPage.goto(`${url}/`);
  try {
    await vaultPage.locator("#vaultView").waitFor({ state: "visible", timeout: 10000 });
  } catch (error) {
    const diagnostic = await vaultPage.evaluate(async () => ({
      notice: document.getElementById("notice").textContent,
      injectedButtons: document.querySelectorAll(".local-vault-key-button").length,
      bridge: await new Promise((resolve) => {
        const id = `diagnostic-${Date.now()}`;
        const timeout = setTimeout(() => resolve("no response"), 1200);
        function onMessage(event) {
          if (event.data?.channel !== "password-vault-local-page-response" || event.data.id !== id) return;
          clearTimeout(timeout);
          window.removeEventListener("message", onMessage);
          resolve(event.data.response);
        }
        window.addEventListener("message", onMessage);
        window.postMessage({ channel: "password-vault-local-page-request", id, type: "sharedState" }, location.origin);
      })
    }));
    throw new Error(`${error.message}; diagnostic=${JSON.stringify(diagnostic)}; errors=${JSON.stringify(vaultErrors)}`);
  }
  assert.equal(await vaultPage.locator("#loginView").isVisible(), false);
  assert.match(await vaultPage.locator("#entries").textContent(), /example\.com/);
  await vaultPage.locator("#newButton").click();
  await vaultPage.locator("#entryName").fill("Shared page");
  await vaultPage.locator("#entrySite").fill("shared.example");
  await vaultPage.locator("#entryUsername").fill("shared-user");
  await vaultPage.locator("#entryPassword").fill("shared-page-secret");
  assert.equal(await vaultPage.locator(".local-vault-key-button").count(), 0);
  loginServer = createHttpServer((request, response) => {
    if (request.url === "/site.css") {
      response.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
      response.end("button { display:block !important; width:100% !important; min-height:36px !important; }");
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'" });
    response.end('<!doctype html><html><head><link rel="stylesheet" href="/site.css"></head><body><form><label>Username<input name="username"></label><label>Password<input id="password" type="password"></label></form></body></html>');
  });
  await new Promise((resolve) => loginServer.listen(0, "127.0.0.1", resolve));
  const loginPage = await context.newPage();
  await loginPage.goto(`http://127.0.0.1:${loginServer.address().port}/`);
  const fillButtonStyle = await loginPage.locator(".local-vault-key-button").evaluate((element) => {
    const style = getComputedStyle(element);
    return { position: style.position, width: style.width, display: style.display };
  });
  assert.deepEqual(fillButtonStyle, { position: "absolute", width: "28px", display: "grid" });
  await loginPage.locator(".local-vault-key-button").click();
  const pickerLayout = await loginPage.locator("#local-vault-picker").evaluate((picker) => {
    const field = document.querySelector("#password").getBoundingClientRect();
    const rect = picker.getBoundingClientRect();
    return { position: getComputedStyle(picker).position, width: rect.width,
      horizontalDistance: Math.abs(rect.right - field.right), verticalDistance: Math.abs(rect.top - field.bottom) };
  });
  assert.equal(pickerLayout.position, "fixed");
  assert(pickerLayout.width >= 250 && pickerLayout.width <= 300, JSON.stringify(pickerLayout));
  assert(pickerLayout.horizontalDistance <= 40 && pickerLayout.verticalDistance <= 20, JSON.stringify(pickerLayout));
  const savePromptStyle = await loginPage.evaluate(() => {
    const prompt = document.createElement("div");
    prompt.id = "local-vault-save-prompt";
    document.documentElement.appendChild(prompt);
    const style = getComputedStyle(prompt);
    const result = { position: style.position, width: style.width };
    prompt.remove();
    return result;
  });
  assert.deepEqual(savePromptStyle, { position: "fixed", width: "300px" });
  await loginPage.close();
  await vaultPage.locator("#saveButton").click();
  await vaultPage.getByText("已保存并同步").waitFor();
  const sharedList = await page.evaluate(() => browser.runtime.sendMessage({ type: "list" }));
  assert(sharedList.entries.some((entry) => entry.site === "shared.example"));
  await page.evaluate(() => browser.runtime.sendMessage({ type: "lock" }));
  await vaultPage.locator("#loginView").waitFor({ state: "visible", timeout: 5000 });
  await page.locator("#unlockPassword").fill("long master password for extension test");
  await page.locator("#unlockForm").locator("button[type=submit]").click();
  await vaultPage.locator("#vaultView").waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await vaultPage.locator("#loginView").isVisible(), false);
  await vaultPage.locator("#lockButton").click();
  await page.locator("#lockedView").waitFor({ state: "visible" });
  await page.locator("#unlockPassword").fill("long master password for extension test");
  await page.locator("#unlockForm").locator("button[type=submit]").click();
  await page.locator("#unlockedView").waitFor({ state: "visible" });
  await page.evaluate(() => browser.runtime.sendMessage({ type: "disconnectSync" }));
  const serverPassword = "different server master password";
  const alternate = await page.evaluate(async (password) => PasswordCrypto.createRecord(password, {
    version: 1, entries: [{ id: crypto.randomUUID(), kind: "site", name: "Server only",
      site: "server.example", username: "bob", password: "server-secret-test",
      subdomains: false, updatedAt: new Date().toISOString() }]
  }), serverPassword);
  const beforeAlternate = await fetch(`${url}/v1/vault`, { headers: { Authorization: `Bearer ${token}` } });
  const expectedAlternateRevision = (await beforeAlternate.json()).revision;
  assert.equal((await fetch(`${url}/v1/vault`, { method: "PUT", headers: {
    Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expectedRevision: expectedAlternateRevision, record: alternate }) })).status, 200);
  const remoteAfter = await fetch(`${url}/v1/vault`, { headers: { Authorization: `Bearer ${token}` } });
  const remoteRecord = (await remoteAfter.json()).record;
  assert.equal(remoteRecord.ciphertext, alternate.ciphertext);
  assert.equal(await page.evaluate(async ({ password, record }) =>
    (await PasswordCrypto.openRecord(password, record)).value.entries[0].site,
  { password: serverPassword, record: remoteRecord }), "server.example");
  const backgroundCheck = await worker.evaluate(async ({ address, password }) => {
    const pair = await localPair(address);
    const remote = await remoteVault(pair.url, pair.token);
    try {
      const opened = await PasswordCrypto.openRecord(password, remote.record);
      return { site: opened.value.entries[0].site, revision: remote.revision };
    } catch (error) { return { error: error.message, revision: remote.revision }; }
  }, { address: url, password: serverPassword });
  assert.equal(backgroundCheck.site, "server.example", JSON.stringify(backgroundCheck));
  await page.reload();
  await page.locator("#syncButton").click();
  await page.locator("#syncConnectLocal").click();
  await page.locator("#syncMergePanel").waitFor({ state: "visible" });
  await page.locator("#syncServerPassword").fill(serverPassword);
  assert.equal(await page.locator("#syncServerPassword").inputValue(), serverPassword);
  await page.locator("#syncPreviewMerge").click();
  await page.waitForFunction(() => !document.getElementById("syncPreviewMerge").disabled);
  const directPreview = await page.evaluate(({ address, password }) =>
    browser.runtime.sendMessage({ type: "previewServerMerge", url: address, password }),
  { address: url, password: serverPassword });
  assert.equal(directPreview.added, 2, JSON.stringify(directPreview));
  assert.equal(await page.locator("#syncMergeReview").isVisible(), true,
    await page.locator("#notice").textContent());
  await page.screenshot({ path: path.join(tmpdir(), "password-vault-0.1-popup-merge.png") });
  await page.locator("#syncApplyMerge").click();
  await page.locator("#syncConnected").waitFor({ state: "visible" });
  const merged = await page.evaluate(() => browser.runtime.sendMessage({ type: "list" }));
  assert(merged.entries.some((entry) => entry.site === "server.example"));
  assert(merged.entries.some((entry) => entry.site === "example.com"));
  await page.evaluate(() => browser.runtime.sendMessage({ type: "lock" }));
  await page.reload();
  await page.screenshot({ path: path.join(tmpdir(), "password-vault-0.1-popup.png") });
  assert.deepEqual(errors, []);
  console.log("Extension browser test passed: MV3 worker, local-service merge, encrypted storage.");
} finally {
  await context?.close();
  if (server) {
    server.kill();
    await new Promise((resolve) => server.once("exit", resolve));
  }
  if (loginServer) await new Promise((resolve) => loginServer.close(resolve));
  await rm(profile, { recursive: true, force: true });
  await rm(directory, { recursive: true, force: true });
}
