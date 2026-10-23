import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = await mkdtemp(path.join(tmpdir(), "password-vault-temporary-test-"));
const profile = path.join(directory, "profile");
const vaultFile = path.join(directory, "vault.json");
const launchOptions = {
  headless: true,
  executablePath: process.env.CHROME_PATH || undefined,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
};
let context;

async function popup() {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
  return page;
}

try {
  context = await chromium.launchPersistentContext(profile, launchOptions);
  const page = await popup();
  const password = "temporary browser session test";
  const record = await page.evaluate(async (masterPassword) => PasswordCrypto.createRecord(masterPassword, {
    version: 1, entries: [{ id: crypto.randomUUID(), kind: "site", name: "Example",
      site: "example.com", username: "test", password: "temporary-secret",
      subdomains: false, updatedAt: new Date().toISOString() }]
  }), password);
  await writeFile(vaultFile, JSON.stringify(record));
  await page.locator("#temporaryEntry").click();
  await page.locator("#fileSourceButton").click();
  await page.locator("#ephemeralFile").setInputFiles(vaultFile);
  await page.locator("#ephemeralPassword").fill(password);
  await page.locator("#ephemeralForm button[type=submit]").click();
  await page.locator("#unlockedView").waitFor({ state: "visible" });
  assert.equal((await page.evaluate(() => browser.runtime.sendMessage({ type: "getState" }))).source, "file");
  assert.equal((await page.evaluate(() => browser.storage.session.get("activeVault"))).activeVault.source, "file");
  assert.equal((await page.evaluate(() => browser.storage.local.get("vaultRecord"))).vaultRecord, undefined);
  await context.close();
  context = null;

  context = await chromium.launchPersistentContext(profile, launchOptions);
  const reopened = await popup();
  assert.equal((await reopened.evaluate(() => browser.runtime.sendMessage({ type: "getState" }))).mode, "setup");
  assert.equal((await reopened.evaluate(() => browser.storage.session.get("activeVault"))).activeVault, undefined);
  assert.equal((await reopened.evaluate(() => browser.storage.local.get("vaultRecord"))).vaultRecord, undefined);
  assert.equal(JSON.parse(await readFile(vaultFile, "utf8")).ciphertext, record.ciphertext);
  console.log("Temporary session test passed: browser restart clears session, imported file remains on disk.");
} finally {
  await context?.close();
  await rm(directory, { recursive: true, force: true });
}
