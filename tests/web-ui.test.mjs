import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium, firefox, webkit } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const engineName = process.env.BROWSER_ENGINE || "chromium";
const engine = { chromium, firefox, webkit }[engineName];
if (!engine) throw new Error(`Unknown browser engine: ${engineName}`);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = await mkdtemp(path.join(tmpdir(), "password-vault-web-test-"));
const probe = net.createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const url = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [path.join(root, "server/server.mjs")], {
  env: { ...process.env, PASSWORD_VAULT_DATA_DIR: directory, PASSWORD_VAULT_PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"]
});
let browser;

async function tokenReady() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error("Test server exited");
    try {
      const token = (await readFile(path.join(directory, "access-token"), "utf8")).trim();
      const response = await fetch(`${url}/v1/vault`, { headers: { Authorization: `Bearer ${token}` } });
      if (response.ok) return token;
    } catch { /* Wait for listener. */ }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("Test server did not start");
}

async function unlock(page, token, password) {
  if (await page.locator("#tokenLabel").isVisible()) await page.locator("#token").fill(token);
  await page.locator("#masterPassword").fill(password);
  await page.locator("#loginButton").click();
  await page.locator("#vaultView").waitFor({ state: "visible" });
}

async function checkLayout(page, label) {
  const layout = await page.evaluate(() => {
    const viewport = document.documentElement.clientWidth;
    const visible = [...document.querySelectorAll("header button, header select, main button, main summary, main input:not([type=hidden])")]
      .filter((element) => element.getClientRects().length && getComputedStyle(element).visibility !== "hidden" && !element.closest("details:not([open])"))
      .map((element) => ({ id: element.id || element.textContent.trim().slice(0, 24),
        left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right }));
    return { viewport, scrollWidth: document.documentElement.scrollWidth,
      clipped: visible.filter((element) => element.left < -1 || element.right > viewport + 1) };
  });
  assert(layout.scrollWidth <= layout.viewport + 1, `${engineName} ${label}: ${JSON.stringify(layout)}`);
  assert.deepEqual(layout.clipped, [], `${engineName} ${label}: clipped controls`);
}

try {
  const token = await tokenReady();
  const html = await fetch(url);
  assert.equal(html.status, 200);
  assert.match(html.headers.get("content-security-policy"), /script-src 'self'/);
  assert.equal((await fetch(`${url}/web/../server/server.mjs`)).status, 404);
  assert.equal((await fetch(`${url}/v1/vault`)).status, 401);
  assert.equal((await fetch(`${url}/v1/local-pair`, { method: "POST" })).status, 404);

  browser = await engine.launch({ headless: true,
    executablePath: engineName === "chromium" ? process.env.CHROME_PATH || undefined : undefined });
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  await page.clock.install();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  const recoveryCheck = await page.evaluate(async () => {
    const backup = await PasswordCrypto.createRecoveryRecord({ version: 1, entries: [] });
    const opened = await PasswordCrypto.openRecoveryRecord(backup.privateKey, backup.record);
    return { scheme: backup.record.scheme, count: opened.value.entries.length,
      privateKeyInRecord: JSON.stringify(backup.record).includes(backup.privateKey.pkcs8) };
  });
  assert.deepEqual(recoveryCheck, { scheme: "RSA-OAEP-3072+AES-256-GCM", count: 0,
    privateKeyInRecord: false });
  await page.locator("#languageSelect").selectOption("en");
  assert.equal(await page.locator("#loginTitle").textContent(), "Open vault");
  await page.locator("#languageSelect").selectOption("zh-CN");
  assert.equal(await page.locator("#loginTitle").textContent(), "打开保险库");
  assert.equal(await page.locator("#tokenLabel").isVisible(), false);
  assert.equal(await page.locator("#token").evaluate((input) => input.required), false);
  assert.equal(await page.locator("#masterPassword").isVisible(), true);
  for (const [width, height] of [[280, 600], [320, 600], [360, 600], [768, 740], [1000, 450], [1200, 740]]) {
    await page.setViewportSize({ width, height });
    await checkLayout(page, `login ${width}x${height}`);
    const geometry = await page.evaluate(() => {
      const form = document.getElementById("loginView").getBoundingClientRect();
      const footer = document.querySelector(".app-footer").getBoundingClientRect();
      return { formCenter: form.left + form.width / 2, footerCenter: footer.left + footer.width / 2,
        formTop: form.top, formBottom: form.bottom, footerTop: footer.top,
        footerBottom: footer.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight };
    });
    assert(Math.abs(geometry.formCenter - width / 2) <= 1, JSON.stringify(geometry));
    assert(Math.abs(geometry.footerCenter - width / 2) <= 1, JSON.stringify(geometry));
    assert(geometry.formTop > 62 && geometry.footerTop > geometry.formBottom + 24,
      JSON.stringify(geometry));
    assert(Math.abs(geometry.footerBottom - geometry.viewportHeight) <= 1, JSON.stringify(geometry));
    if (width === 280 || width === 360 || width >= 1000) {
      await page.screenshot({ path: path.join(tmpdir(), `password-vault-${engineName}-login-${width}.png`) });
    }
  }
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.locator("#guideButton").click();
  assert.equal(await page.locator("#guideDialog").isVisible(), true);
  assert.match(await page.locator("#guideDialog").textContent(), /合并/);
  assert.doesNotMatch(await page.locator("#guideDialog").textContent(), /下载密文|同步密文|密文副本/);
  assert.equal(await page.locator("#importClientButton").textContent(), "导入密码文件");
  await page.locator("#guideClose").click();
  const password = "long master password for browser test";
  const clientRecord = await page.evaluate(async (masterPassword) => PasswordCrypto.createRecord(masterPassword, {
    version: 1, entries: [{ id: crypto.randomUUID(), kind: "app", name: "示例 App", site: "示例 App",
      username: "mobile-user", password: "mobile-secret", subdomains: false, updatedAt: new Date().toISOString() }]
  }), password);
  await page.locator("#clientVaultFile").setInputFiles({ name: "client-vault.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(clientRecord)) });
  assert.equal(await page.locator("#token").inputValue(), "");
  await page.locator("#masterPassword").fill(password);
  await page.locator("#loginButton").click();
  await page.locator("#vaultView").waitFor({ state: "visible" });
  const localhostPage = await context.newPage();
  await localhostPage.goto(`http://localhost:${port}/`);
  assert.equal(await localhostPage.locator("#tokenLabel").isVisible(), false);
  await unlock(localhostPage, token, password);
  const fallbackPage = await context.newPage();
  await fallbackPage.goto(url);
  await fallbackPage.route(`http://127.0.0.1:${port + 1}/v1/local-pair`, (route) => route.abort());
  await fallbackPage.locator("#masterPassword").fill(password);
  await fallbackPage.locator("#loginButton").click();
  await fallbackPage.locator("#tokenLabel").waitFor({ state: "visible" });
  await fallbackPage.locator("#token").fill(token);
  await fallbackPage.locator("#loginButton").click();
  await fallbackPage.locator("#vaultView").waitFor({ state: "visible" });
  assert.equal(await page.getByText(/示例 App/).count(), 1);
  await page.locator("#newButton").click();
  await page.locator("#entryName").fill("Test site");
  await page.locator("#entrySite").fill("example.com");
  await page.locator("#entryUsername").fill("alice");
  await page.locator("#entryPassword").fill("secret-web-test");
  await page.locator("#saveButton").click();
  await page.getByText("已保存并同步").waitFor();
  await page.locator("#toolbarMenu summary").click();
  assert.equal(await page.locator("#refreshButton").isVisible(), true);
  await page.locator("#refreshButton").click();
  assert.equal(await page.locator("#toolbarMenu").evaluate((menu) => menu.open), false);
  const disk = await readFile(path.join(directory, "vault.json"), "utf8");
  assert(!disk.includes("secret-web-test"));
  await page.screenshot({ path: path.join(tmpdir(), `password-vault-${engineName}-desktop.png`) });
  await checkLayout(page, "desktop account");

  await page.reload();
  await page.locator("#loginView").waitFor({ state: "visible" });
  await unlock(page, token, password);
  await page.getByRole("button", { name: /Test site/ }).click();
  assert.equal(await page.locator("#entryPassword").inputValue(), "secret-web-test");

  const second = await context.newPage();
  await second.goto(url);
  await unlock(second, token, password);
  await second.getByRole("button", { name: /Test site/ }).click();
  await page.locator("#entryPassword").fill("new-password-first");
  await page.locator("#saveButton").click();
  await page.getByText("已保存并同步").waitFor();
  second.once("dialog", (dialog) => dialog.accept());
  await second.locator("#entryPassword").fill("new-password-second");
  await second.locator("#saveButton").click();
  await second.getByText("已保存并同步").waitFor();
  await page.clock.runFor(61 * 1000);
  await page.waitForFunction(() => document.getElementById("entryPassword").value === "new-password-second");
  assert.equal(await page.locator("#entryPassword").inputValue(), "new-password-second");

  const mobileContext = await browser.newContext({ viewport: { width: 360, height: 740 } });
  const mobile = await mobileContext.newPage();
  await mobile.goto(url);
  await unlock(mobile, token, password);
  await mobile.screenshot({ path: path.join(tmpdir(), `password-vault-${engineName}-mobile-list.png`) });
  await checkLayout(mobile, "mobile list 360px");
  await mobile.getByRole("button", { name: /Test site/ }).click();
  await mobile.screenshot({ path: path.join(tmpdir(), `password-vault-${engineName}-mobile-detail.png`) });
  await checkLayout(mobile, "mobile detail 360px");
  assert.equal(await mobile.locator("#entryForm").isVisible(), true);
  for (const width of [280, 320, 768]) {
    await mobile.setViewportSize({ width, height: 740 });
    await checkLayout(mobile, `account detail ${width}px`);
    await mobile.screenshot({ path: path.join(tmpdir(), `password-vault-${engineName}-detail-${width}.png`) });
  }

  const importPage = await context.newPage();
  await importPage.goto(url);
  const separatePassword = "separate client master password";
  const replacement = await importPage.evaluate(async (masterPassword) => PasswordCrypto.createRecord(masterPassword, {
    version: 1, entries: [
      { id: crypto.randomUUID(), kind: "site", name: "Test site", site: "example.com",
        username: "alice", password: "imported-update", subdomains: false, updatedAt: new Date().toISOString() },
      { id: crypto.randomUUID(), kind: "site", name: "Extra", site: "extra.example",
        username: "new", password: "imported-extra", subdomains: false, updatedAt: new Date().toISOString() }
    ]
  }), separatePassword);
  await importPage.locator("#clientVaultFile").setInputFiles({ name: "another-vault.json",
    mimeType: "application/json", buffer: Buffer.from(JSON.stringify(replacement)) });
  await importPage.locator("#masterPassword").fill(password);
  await importPage.locator("#clientPassword").fill(separatePassword);
  await importPage.locator("#loginButton").click();
  await importPage.locator("#importReview").waitFor({ state: "visible" });
  assert.match(await importPage.locator("#importSummary").textContent(), /新增 1、更新 1/);
  await importPage.screenshot({ path: path.join(tmpdir(), "password-vault-0.1-import-review.png") });
  await importPage.setViewportSize({ width: 360, height: 740 });
  assert.equal(await importPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await importPage.screenshot({ path: path.join(tmpdir(), "password-vault-0.1-import-mobile.png") });
  await importPage.setViewportSize({ width: 1200, height: 800 });
  await importPage.locator("#confirmImport").click();
  await importPage.locator("#vaultView").waitFor({ state: "visible" });
  await importPage.getByRole("button", { name: /Test site/ }).click();
  assert.equal(await importPage.locator("#entryPassword").inputValue(), "imported-update");
  assert.equal(await importPage.getByRole("button", { name: /Extra/ }).count(), 1);
  assert.equal(await importPage.getByRole("button", { name: /示例 App/ }).count(), 1);

  await importPage.locator("#historyTab").click();
  await importPage.locator("#historyList button").first().click();
  await importPage.locator("#restoreForm").waitFor({ state: "visible" });
  await importPage.locator("#downloadCurrent").click();
  await importPage.locator("#restorePassword").fill(password);
  await importPage.locator("#restoreConfirm").check();
  await importPage.locator("#restoreButton").click();
  await importPage.locator("#accountsView").waitFor({ state: "visible" });
  assert.equal(await importPage.getByRole("button", { name: /Extra/ }).count(), 0);

  await importPage.locator("#devicesTab").click();
  await importPage.locator("#deviceName").fill("Test phone");
  await importPage.locator("#createDevice").click();
  await importPage.locator("#issuedDevice").waitFor({ state: "visible" });
  const deviceToken = await importPage.locator("#issuedToken").inputValue();
  assert.equal((await fetch(`${url}/v1/vault`, {
    headers: { Authorization: `Bearer ${deviceToken}` } })).status, 200);
  importPage.once("dialog", (dialog) => dialog.accept());
  await importPage.locator("#deviceList button").click();
  await importPage.getByText("设备访问已撤销").waitFor();
  assert.equal((await fetch(`${url}/v1/vault`, {
    headers: { Authorization: `Bearer ${deviceToken}` } })).status, 401);
  await importPage.screenshot({ path: path.join(tmpdir(), "password-vault-0.1-devices.png") });
  await importPage.setViewportSize({ width: 320, height: 740 });
  assert.equal(await importPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await importPage.screenshot({ path: path.join(tmpdir(), "password-vault-0.1-devices-mobile.png") });

  const replacePage = await context.newPage();
  await replacePage.goto(url);
  await replacePage.locator("#clientVaultFile").setInputFiles({ name: "another-vault.json",
    mimeType: "application/json", buffer: Buffer.from(JSON.stringify(replacement)) });
  await replacePage.locator("#masterPassword").fill(password);
  await replacePage.locator("#clientPassword").fill(separatePassword);
  await replacePage.locator("#loginButton").click();
  await replacePage.locator("#importReview").waitFor({ state: "visible" });
  await replacePage.locator('input[name="importMode"][value="replace"]').check();
  replacePage.once("dialog", (dialog) => dialog.accept());
  await replacePage.locator("#confirmImport").click();
  await replacePage.locator("#vaultView").waitFor({ state: "visible" });
  assert.equal(await replacePage.getByRole("button", { name: /示例 App/ }).count(), 0);
  assert.equal(await replacePage.getByRole("button", { name: /Extra/ }).count(), 1);
  assert.deepEqual(errors, []);
  console.log(`${engineName} web UI test passed: import merge and replace, history restore, devices, responsive layout.`);
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    server.kill();
    await new Promise((resolve) => server.once("exit", resolve));
  }
  await rm(directory, { recursive: true, force: true });
}
