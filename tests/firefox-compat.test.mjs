import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function area() {
  const values = {};
  return {
    async get(keys) {
      if (keys == null) return { ...values };
      const names = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(names.filter((name) => name in values).map((name) => [name, values[name]]));
    },
    async set(next) { Object.assign(values, next); },
    async remove(keys) { for (const name of Array.isArray(keys) ? keys : [keys]) delete values[name]; }
  };
}

let onMessage;
const browser = {
  storage: { local: area(), session: area() },
  alarms: { create: async () => {}, clear: async () => {}, onAlarm: { addListener() {} } },
  runtime: { id: "firefox-test", getURL: () => "moz-extension://firefox-test/",
    getManifest: () => ({ version: "0.1.0" }), onMessage: { addListener(listener) { onMessage = listener; } } },
  contextMenus: {}
};
const context = vm.createContext({ browser, crypto: webcrypto, fetch, AbortController, URL,
  TextEncoder, TextDecoder, atob, btoa, setTimeout, clearTimeout, console });
for (const file of ["crypto.js", "sync.js", "background.js"]) {
  vm.runInContext(await readFile(path.join(root, file), "utf8"), context, { filename: file });
}
const sender = { id: "firefox-test", url: "moz-extension://firefox-test/popup.html" };
const send = (message) => onMessage(message, sender, () => { throw new Error("Firefox should return a Promise"); });
assert.equal((await send({ type: "getState" })).mode, "setup");
assert.equal((await send({ type: "setup", password: "long master password for firefox test" })).mode, "unlocked");
assert.equal((await send({ type: "saveEntry", entry: {
  name: "Firefox", site: "example.com", username: "alice", password: "secret-firefox-test"
} })).entry.username, "alice");
assert.equal((await send({ type: "list" })).entries.length, 1);
assert(!JSON.stringify(await browser.storage.local.get(null)).includes("secret-firefox-test"));
console.log("Firefox compatibility test passed: background page, Promise messages, encrypted storage.");
