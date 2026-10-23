if (typeof importScripts === "function") importScripts("crypto.js", "sync.js");
const promiseMessages = Boolean(globalThis.browser &&
  globalThis.browser.runtime.getURL("").startsWith("moz-extension:"));
const extensionApi = promiseMessages ? globalThis.browser : (globalThis.chrome || globalThis.browser);

const DEFAULT_AUTO_LOCK_MINUTES = 30;
const EPHEMERAL_AUTO_LOCK_MINUTES = 5;
const AUTO_LOCK_OPTIONS = [5, 30, 60];
const AUTO_LOCK_ALARM = "local-vault-auto-lock";
const AUTO_SYNC_ALARM = "local-vault-auto-sync";
const ACTIVE_VAULT = "activeVault";
const SYNC_STATUS = "syncStatus";
const PENDING_LOGIN_PREFIX = "pendingLogin:";
const PENDING_LOGIN_LIFETIME = 10 * 60 * 1000;
let session = { key: null, vault: null, record: null, ephemeral: false, lastActivity: 0, id: null };
let sessionReady;
let requestQueue = Promise.resolve();

async function storedRecord() {
  const result = await extensionApi.storage.local.get("vaultRecord");
  return result.vaultRecord || null;
}

async function autoLockMinutes(ephemeral = session.ephemeral) {
  if (ephemeral) return EPHEMERAL_AUTO_LOCK_MINUTES;
  const saved = (await extensionApi.storage.local.get("autoLockMinutes")).autoLockMinutes;
  return AUTO_LOCK_OPTIONS.includes(saved) ? saved : DEFAULT_AUTO_LOCK_MINUTES;
}

async function autoLockDuration(ephemeral = session.ephemeral) {
  return (await autoLockMinutes(ephemeral)) * 60 * 1000;
}

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${PasswordCrypto.generatePassword(10)}`;
}

async function clearSession() {
  session = { key: null, vault: null, record: null, ephemeral: false, lastActivity: 0, id: null };
  const stored = await extensionApi.storage.session.get(null);
  const transient = Object.keys(stored).filter((key) => (
    key.startsWith(PENDING_LOGIN_PREFIX) || key.startsWith("suggestion:")
  ));
  await extensionApi.storage.session.remove([ACTIVE_VAULT, ...transient]);
  await extensionApi.alarms.clear(AUTO_LOCK_ALARM);
  await extensionApi.alarms.clear(AUTO_SYNC_ALARM);
}

async function expireIfNeeded() {
  if (session.vault && Date.now() - session.lastActivity >= await autoLockDuration()) {
    await clearSession();
    return true;
  }
  return false;
}

function requireUnlocked() {
  if (!session.key || !session.vault) throw new Error("LOCKED");
}

function requireWritableVault() {
  requireUnlocked();
  if (session.ephemeral) throw new Error("临时模式仅供查看和填充，不能修改账号");
}

async function saveSession() {
  if (!session.vault) return;
  await extensionApi.storage.session.set({
    [ACTIVE_VAULT]: {
      key: await PasswordCrypto.exportKey(session.key),
      record: session.ephemeral ? session.record : null,
      salt: session.record.salt,
      ephemeral: session.ephemeral,
      lastActivity: session.lastActivity,
      id: session.id
    }
  });
  await extensionApi.alarms.create(AUTO_LOCK_ALARM, { when: session.lastActivity + await autoLockDuration() });
}

async function markActivity() {
  if (session.vault) {
    session.lastActivity = Date.now();
    await saveSession();
  }
}

async function restoreSession() {
  const saved = (await extensionApi.storage.session.get(ACTIVE_VAULT))[ACTIVE_VAULT];
  if (!saved) return;
  if (!Number.isFinite(saved.lastActivity) || Date.now() - saved.lastActivity >= await autoLockDuration(Boolean(saved.ephemeral))) {
    await clearSession();
    return;
  }
  try {
    const record = saved.ephemeral ? saved.record : await storedRecord();
    if (!record || record.salt !== saved.salt) throw new Error("会话与保险库不匹配");
    const key = await PasswordCrypto.importKey(saved.key);
    const vault = await PasswordCrypto.decryptWithKey(key, record);
    if (!vault || !Array.isArray(vault.entries)) throw new Error("保险库格式无效");
    session = { key, vault, record, ephemeral: Boolean(saved.ephemeral), lastActivity: saved.lastActivity,
      id: saved.id || newId() };
    await extensionApi.alarms.create(AUTO_LOCK_ALARM, { when: session.lastActivity + await autoLockDuration() });
    await scheduleAutoSync(1000);
  } catch {
    await clearSession();
  }
}

async function openSession(opened, record, ephemeral = false) {
  session = {
    key: opened.key,
    vault: opened.value,
    record,
    ephemeral,
    lastActivity: Date.now(),
    id: newId()
  };
  await markActivity();
  await scheduleAutoSync(1000);
}

async function persistVault() {
  requireWritableVault();
  const encrypted = await PasswordCrypto.encryptWithKey(session.key, session.vault);
  session.record = {
    ...(session.record || {}),
    version: session.record?.version || 1,
    iv: encrypted.iv,
    ciphertext: encrypted.ciphertext
  };
  if (!session.ephemeral) await extensionApi.storage.local.set({ vaultRecord: session.record });
  else await saveSession();
  if (await scheduleAutoSync()) {
    await setSyncStatus("pending", "本机更改待自动同步");
  }
  await notifySharedPages();
}

async function syncSettings() {
  requireUnlocked();
  if (session.ephemeral) throw new Error("便携模式不能连接同步服务器");
  const stored = (await extensionApi.storage.local.get("syncSettings")).syncSettings;
  if (!stored) return null;
  if (stored.salt !== session.record.salt) throw new Error("同步设置与当前保险库不匹配，请重新连接");
  return PasswordCrypto.decryptWithKey(session.key, stored);
}

async function saveSyncSettings(settings) {
  const encrypted = await PasswordCrypto.encryptWithKey(session.key, settings);
  const localSyncUrl = loopbackOrigin(settings.url);
  await extensionApi.storage.local.set({ syncSettings: { salt: session.record.salt, ...encrypted },
    ...(localSyncUrl ? { localSyncUrl } : {}) });
}

async function setSyncStatus(kind, message = "", extra = {}) {
  await extensionApi.storage.session.set({ [SYNC_STATUS]: { kind, message, ...extra } });
}

function syncErrorKind(error) {
  const message = error?.message || "";
  return /超时|未运行|连接|网络|fetch|Network|Failed to fetch/i.test(message) ? "offline" : "error";
}

async function scheduleAutoSync(delayMs = 30000) {
  if (!session.vault || session.ephemeral) return false;
  try {
    const connected = await syncSettings();
    const enabled = (await extensionApi.storage.local.get("syncAutoConnect")).syncAutoConnect !== false;
    if (connected || enabled) {
      await extensionApi.alarms.create(AUTO_SYNC_ALARM, { when: Date.now() + delayMs });
      return Boolean(connected);
    }
  } catch {
    // A broken connection must not prevent a local save.
  }
  return false;
}

async function localPair(url = "http://127.0.0.1:39871") {
  const endpoint = VaultSync.endpoint(url);
  const parsed = new URL(endpoint);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" ||
      !parsed.port || Number(parsed.port) >= 65535) {
    throw new Error("本机配对只支持 127.0.0.1 地址");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(`http://127.0.0.1:${Number(parsed.port) + 1}/v1/local-pair`, {
      method: "POST", cache: "no-store", credentials: "omit", redirect: "error",
      referrerPolicy: "no-referrer", signal: controller.signal
    });
    if (!response.ok) throw new Error("本机配对服务未运行");
    const pair = await response.json();
    if (pair.url !== endpoint || !/^[0-9a-f]{64}$/.test(pair.token)) throw new Error("本机配对信息无效");
    return pair;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("本机服务连接超时");
    if (error instanceof TypeError) throw new Error("本机服务未运行，请先启动同步服务");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function connectToSyncUnsafe(url, token) {
  requireUnlocked();
  if (session.ephemeral) throw new Error("便携模式不能连接同步服务器");
  if (await syncSettings()) throw new Error("已连接服务器，请先断开再重新连接");
  url = VaultSync.endpoint(url);
  token = String(token || "").trim();
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error("服务器令牌格式无效");
  const remote = await remoteVault(url, token);
  let record = session.record;
  let revision = remote.revision;
  if (!remote.record) {
    revision = (await remoteVault(url, token, "PUT", { expectedRevision: 0, record })).revision;
  } else {
    if (remote.record.salt !== record.salt) throw new Error("服务器已有另一份保险库，请勿覆盖；新浏览器可从服务器加入");
    const value = await PasswordCrypto.decryptWithKey(session.key, remote.record);
    if (!VaultSync.equivalentVault(value, session.vault)) {
      throw new Error("服务器与本机内容不同，请先备份并核对，不能自动覆盖");
    }
    record = remote.record;
    await replaceLocalFromSync(record, value);
  }
  await saveSyncSettings({ url, token, revision, baseRecord: record,
    lastSyncedAt: new Date().toISOString() });
  await extensionApi.storage.session.set({ [SYNC_STATUS]: { kind: "ok" } });
  await scheduleAutoSync(1000);
  return { connected: true, revision };
}

async function connectToSync(url, token) {
  await setSyncStatus("connecting", "正在连接服务器…");
  try {
    const result = await connectToSyncUnsafe(url, token);
    await setSyncStatus("ok", "已同步");
    return result;
  } catch (error) {
    await setSyncStatus(syncErrorKind(error), error.message || "连接服务器失败");
    throw error;
  }
}

function mergeRequired(error) {
  return error.message === "服务器已有另一份保险库，请勿覆盖；新浏览器可从服务器加入" ||
    error.message === "服务器与本机内容不同，请先备份并核对，不能自动覆盖";
}

async function mergeTarget(url, token) {
  if (!url && !token) return localPair();
  if (url && !token) return localPair(url);
  const endpoint = VaultSync.endpoint(url);
  if (!/^[0-9a-f]{64}$/.test(String(token || ""))) throw new Error("服务器令牌格式无效");
  return { url: endpoint, token };
}

async function previewServerMerge(message) {
  requireUnlocked();
  if (session.ephemeral || await syncSettings()) throw new Error("当前保险库不能执行首次合并");
  const target = await mergeTarget(message.url, message.token);
  const remote = await remoteVault(target.url, target.token);
  if (!remote.record) throw new Error("服务器没有保险库，请直接连接");
  let opened;
  try { opened = await PasswordCrypto.openRecord(message.password, remote.record); }
  catch { throw new Error("服务器主密码不正确，或保险库数据已损坏"); }
  if (!opened.value || !Array.isArray(opened.value.entries)) throw new Error("服务器保险库格式无效");
  const plan = VaultSync.combine(session.vault, opened.value);
  return { revision: remote.revision, local: session.vault.entries.length,
    server: opened.value.entries.length, added: plan.added, updated: plan.updated, same: plan.same };
}

async function applyServerMerge(message) {
  requireUnlocked();
  if (session.ephemeral || await syncSettings()) throw new Error("当前保险库不能执行首次合并");
  const target = await mergeTarget(message.url, message.token);
  const remote = await remoteVault(target.url, target.token);
  if (remote.revision !== message.expectedRevision || !remote.record) {
    throw new Error("服务器数据已变化，请重新核对两份账号");
  }
  let opened;
  try { opened = await PasswordCrypto.openRecord(message.password, remote.record); }
  catch { throw new Error("服务器主密码不正确，或保险库数据已损坏"); }
  if (!opened.value || !Array.isArray(opened.value.entries)) throw new Error("服务器保险库格式无效");
  const plan = VaultSync.combine(session.vault, opened.value);
  let record = remote.record;
  let revision = remote.revision;
  if (plan.added || plan.updated) {
    const encrypted = await PasswordCrypto.encryptWithKey(opened.key, plan.vault);
    record = { ...record, ...encrypted };
    revision = (await remoteVault(target.url, target.token, "PUT", {
      expectedRevision: remote.revision, record
    })).revision;
  }
  const settings = { url: target.url, token: target.token, revision, baseRecord: record,
    lastSyncedAt: new Date().toISOString() };
  const encryptedSettings = await PasswordCrypto.encryptWithKey(opened.key, settings);
  await extensionApi.storage.local.set({ vaultRecord: record,
    syncSettings: { salt: record.salt, ...encryptedSettings },
    syncAutoConnect: true, localSyncUrl: target.url });
  session = { ...session, key: opened.key, vault: plan.vault, record };
  await markActivity();
  await extensionApi.storage.session.set({ [SYNC_STATUS]: { kind: "ok" } });
  await scheduleAutoSync(1000);
  return { connected: true, revision, added: plan.added, updated: plan.updated, same: plan.same };
}

async function runSync(decisions = {}) {
  await setSyncStatus("syncing", "正在同步本机更改…");
  try {
    let result;
    try {
      result = await synchronize(decisions);
    } catch (error) {
      const settings = await syncSettings();
      if (error.message !== "服务器令牌无效" || !settings?.url.startsWith("http://127.0.0.1:")) throw error;
      const pair = await localPair(settings.url);
      await saveSyncSettings({ ...settings, token: pair.token });
      result = await synchronize(decisions);
    }
    await extensionApi.storage.session.set({ [SYNC_STATUS]: result.status === "conflict"
      ? { kind: "conflict", message: "两端修改了同一账号，请在同步页处理", conflicts: result.conflicts }
      : { kind: "ok", message: result.status === "unchanged" ? "两端已是最新" : "已同步" } });
    await notifySharedPages();
    return result;
  } catch (error) {
    await setSyncStatus(syncErrorKind(error), error.message || "同步失败");
    throw error;
  }
}

async function remoteVault(url, token, method = "GET", body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${VaultSync.endpoint(url)}/v1/vault`, {
      method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer",
      signal: controller.signal
    });
    if (response.status === 401) throw new Error("服务器令牌无效");
    if (response.status === 409) throw new Error("服务器刚被另一台设备更新，请重试同步");
    if (!response.ok) throw new Error(`服务器返回 ${response.status}`);
    const value = await response.json();
    if (!Number.isSafeInteger(value.revision) || value.revision < 0 ||
        (method === "GET" && value.revision > 0 && !VaultSync.validRecord(value.record))) {
      throw new Error("服务器数据格式无效");
    }
    return value;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("连接服务器超时");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function replaceLocalFromSync(record, vault) {
  session.record = record;
  session.vault = vault;
  await extensionApi.storage.local.set({ vaultRecord: record });
}

async function synchronize(decisions = {}) {
  const settings = await syncSettings();
  if (!settings) throw new Error("尚未连接同步服务器");
  const remote = await remoteVault(settings.url, settings.token);
  if (remote.revision < settings.revision || !remote.record) {
    throw new Error("服务器数据被重置或回退，已停止同步；请先检查服务器备份");
  }
  if (remote.record.salt !== session.record.salt) throw new Error("服务器与本机不是同一保险库");
  if (remote.revision === settings.revision && !VaultSync.same(remote.record, settings.baseRecord)) {
    throw new Error("服务器数据发生变化，但版本号未更新，已停止同步");
  }
  const localChanged = !VaultSync.same(session.record, settings.baseRecord);
  let nextRecord = session.record;
  let nextVault = session.vault;
  let status = "unchanged";
  if (remote.revision > settings.revision) {
    const base = await PasswordCrypto.decryptWithKey(session.key, settings.baseRecord);
    const remoteValue = await PasswordCrypto.decryptWithKey(session.key, remote.record);
    const merged = VaultSync.merge(base, session.vault, remoteValue, decisions);
    if (merged.conflicts.length) return { status: "conflict", conflicts: merged.conflicts };
    nextVault = merged.vault;
    if (VaultSync.equivalentVault(merged.vault, remoteValue)) {
      nextRecord = remote.record;
      status = "downloaded";
    } else {
      const encrypted = await PasswordCrypto.encryptWithKey(session.key, merged.vault);
      nextRecord = { ...session.record, iv: encrypted.iv, ciphertext: encrypted.ciphertext };
      status = "merged";
    }
  } else if (localChanged) {
    status = "uploaded";
  }
  let revision = remote.revision;
  if (status === "uploaded" || status === "merged") {
    revision = (await remoteVault(settings.url, settings.token, "PUT", {
      expectedRevision: remote.revision, record: nextRecord
    })).revision;
  }
  if (status === "downloaded" || status === "merged") await replaceLocalFromSync(nextRecord, nextVault);
  await saveSyncSettings({ ...settings, revision, baseRecord: nextRecord, lastSyncedAt: new Date().toISOString() });
  return { status, revision };
}

function hostMatches(entryHost, currentHost, allowSubdomains = false) {
  const entry = PasswordCrypto.normalizeHost(entryHost);
  const current = PasswordCrypto.normalizeHost(currentHost);
  return Boolean(entry && current && (entry === current || (allowSubdomains && current.endsWith(`.${entry}`))));
}

function entryTarget(entry) {
  return entry?.kind === "app"
    ? String(entry.site || "").trim().toLowerCase()
    : PasswordCrypto.normalizeHost(entry?.site);
}

function pageFromSender(sender) {
  const source = sender.url || (sender.frameId === 0 ? sender.tab?.url : null);
  if (!sender.tab || !source) return null;
  try {
    const page = new URL(source);
    return page.protocol === "http:" || page.protocol === "https:" ? page : null;
  } catch {
    return null;
  }
}

const sharedPageMessages = new Set([
  "sharedState", "sharedAccess", "sharedUnlock", "sharedTouch", "sharedLock", "sharedCommit"
]);

function loopbackOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || !url.port) return null;
    return url.origin;
  } catch {
    return null;
  }
}

async function sharedPage(sender) {
  const page = pageFromSender(sender);
  if (!page || sender.frameId !== 0 || !["127.0.0.1", "localhost"].includes(page.hostname) || !page.port) {
    return null;
  }
  const stored = await extensionApi.storage.local.get(["localSyncUrl", "vaultRecord", "syncSettings"]);
  const origin = loopbackOrigin(stored.localSyncUrl);
  if (!origin || origin !== page.origin || !stored.vaultRecord ||
      stored.syncSettings?.salt !== stored.vaultRecord.salt) return null;
  return { page, origin, stored };
}

async function sharedSettings(pageInfo) {
  if (!session.vault || session.ephemeral) return null;
  const settings = await syncSettings();
  if (!settings || loopbackOrigin(settings.url) !== pageInfo.origin) return null;
  return settings;
}

async function sharedAccess(pageInfo, settings = null) {
  if (!session.vault) return { available: true, unlocked: false };
  const current = settings || await sharedSettings(pageInfo);
  if (!current) return { available: false };
  return {
    available: true,
    unlocked: Boolean(session.vault),
    sessionId: session.id,
    token: current.token,
    key: await PasswordCrypto.exportKey(session.key),
    salt: session.record.salt,
    expiresAt: session.lastActivity + await autoLockDuration()
  };
}

async function unlockSharedSession(message, sender) {
  const pageInfo = await sharedPage(sender);
  if (!pageInfo) throw new Error("本机管理页未连接到此浏览器的同步服务");
  await expireIfNeeded();
  if (session.vault) return sharedAccess(pageInfo);
  const storedRecordValue = pageInfo.stored.vaultRecord;
  const savedSettings = pageInfo.stored.syncSettings;
  let opened;
  try { opened = await PasswordCrypto.openRecord(String(message.password || ""), storedRecordValue); }
  catch { throw new Error("主密码不正确"); }
  let settings;
  try { settings = await PasswordCrypto.decryptWithKey(opened.key, savedSettings); }
  catch { throw new Error("主密码不正确，或同步设置已损坏"); }
  if (loopbackOrigin(settings.url) !== pageInfo.origin || typeof settings.token !== "string") {
    throw new Error("此浏览器尚未连接当前本机服务");
  }
  await openSession(opened, storedRecordValue, false);
  return sharedAccess(pageInfo, settings);
}

async function notifySharedPages() {
  if (!extensionApi.tabs?.query || !extensionApi.tabs?.sendMessage || !session.vault || session.ephemeral) return;
  const settings = await syncSettings().catch(() => null);
  if (!settings || !loopbackOrigin(settings.url)) return;
  const tabs = await extensionApi.tabs.query({});
  await Promise.all(tabs.filter((tab) => tab?.id).map(async (tab) => {
    try { await extensionApi.tabs.sendMessage(tab.id, { type: "sharedVaultChanged", revision: settings.revision }); }
    catch { /* Most tabs do not have the local-page bridge. */ }
  }));
}

async function pendingLogin(tabId) {
  const key = `${PENDING_LOGIN_PREFIX}${tabId}`;
  const pending = (await extensionApi.storage.session.get(key))[key];
  if (!pending) return null;
  if (Date.now() - pending.createdAt > PENDING_LOGIN_LIFETIME || pending.salt !== session.record?.salt) {
    await extensionApi.storage.session.remove(key);
    return null;
  }
  return pending;
}

async function pendingLoginSummary(tabId, pending) {
  try {
    const value = await PasswordCrypto.decryptWithKey(session.key, pending);
    const existing = matchingPendingEntry(value, pending.kind);
    if (existing?.password === value.password) {
      await extensionApi.storage.session.remove(`${PENDING_LOGIN_PREFIX}${tabId}`);
      return null;
    }
    return {
      tabId, token: pending.token, site: value.site, username: existing?.username || value.username || "",
      action: existing ? "update" : "save"
    };
  } catch {
    await extensionApi.storage.session.remove(`${PENDING_LOGIN_PREFIX}${tabId}`);
    return null;
  }
}

function matchingPendingEntry(value, kind) {
  const entries = session.vault.entries.filter((entry) => entry.kind !== "app" && entryTarget(entry) === value.site);
  if (value.username) {
    const byUsername = entries.find((entry) => entry.username === value.username);
    if (byUsername) return byUsername;
  }
  const byCurrentPassword = entries.filter((entry) => value.currentPassword && entry.password === value.currentPassword);
  if (byCurrentPassword.length === 1) return byCurrentPassword[0];
  return kind === "change" && entries.length === 1 ? entries[0] : null;
}

async function commitPendingLogin(tabId, pending, username) {
  requireWritableVault();
  const value = await PasswordCrypto.decryptWithKey(session.key, pending);
  const normalizedUsername = String(username || "").trim().slice(0, 320);
  if (!normalizedUsername) throw new Error("请填写登录账号");
  const existing = session.vault.entries.find((entry) => (
    PasswordCrypto.normalizeHost(entry.site) === value.site && entry.username === normalizedUsername
  ));
  if (existing) {
    existing.password = value.password;
    existing.updatedAt = new Date().toISOString();
  } else {
    session.vault.entries.unshift({
      id: newId(), name: value.site, site: value.site, username: normalizedUsername,
      password: value.password, subdomains: false, updatedAt: new Date().toISOString()
    });
  }
  await persistVault();
  await extensionApi.storage.session.remove(`${PENDING_LOGIN_PREFIX}${tabId}`);
  await markActivity();
  return { saved: true, updated: Boolean(existing) };
}

async function suggestionContext(token) {
  if (!/^[0-9a-f-]{36}$/i.test(String(token || ""))) throw new Error("建议窗口已失效，请从注册页重新打开");
  const context = (await extensionApi.storage.session.get(`suggestion:${token}`))[`suggestion:${token}`];
  if (!context || Date.now() - context.createdAt > 15 * 60 * 1000) {
    throw new Error("建议窗口已过期，请从注册页重新打开");
  }
  return context;
}

async function messageToSuggestionTab(context, type, password, currentPassword = "") {
  try {
    return await extensionApi.tabs.sendMessage(context.tabId, {
      type, token: context.token, password, currentPassword
    }, { frameId: context.frameId });
  } catch {
    throw new Error("注册页已关闭或重新加载，请从页面重新打开建议");
  }
}

async function handleMessage(message, sender) {
  const trustedPage = sender.id === extensionApi.runtime.id && sender.url?.startsWith(extensionApi.runtime.getURL(""));
  const sharedPageRequest = sharedPageMessages.has(message?.type);
  const trustedSharedPage = sharedPageRequest && Boolean(await sharedPage(sender));
  if (!trustedPage && !trustedSharedPage && (!sender.tab || ![
    "getMatches", "getEntry", "openSuggestion", "stageLogin", "getPendingLogin", "confirmPendingLogin", "discardPendingLogin"
  ].includes(message?.type))) {
    throw new Error("请求来源无效");
  }
  await (sessionReady ||= restoreSession());
  await expireIfNeeded();
  switch (message.type) {
    case "getState": {
      const record = await storedRecord();
      const quick = (await extensionApi.storage.local.get("quickUnlock")).quickUnlock;
      return {
        mode: record || session.ephemeral ? (session.vault ? "unlocked" : "locked") : "setup",
        ephemeral: Boolean(session.ephemeral && session.vault),
        quickUnlock: Boolean(record && quick?.salt === record.salt),
        quickCredentialId: record && quick?.salt === record.salt ? quick.credentialId : null,
        quickPrfSalt: record && quick?.salt === record.salt ? quick.prfSalt : null,
        autoLockMinutes: await autoLockMinutes(),
        extensionVersion: extensionApi.runtime.getManifest().version
      };
    }
    case "sharedState": {
      const pageInfo = await sharedPage(sender);
      if (!pageInfo) return { available: false };
      await expireIfNeeded();
      const settings = await sharedSettings(pageInfo);
      return settings
        ? { available: true, unlocked: Boolean(session.vault), sessionId: session.id,
            expiresAt: session.vault ? session.lastActivity + await autoLockDuration() : null }
        : { available: false };
    }
    case "sharedAccess": {
      const pageInfo = await sharedPage(sender);
      if (!pageInfo) return { available: false };
      await expireIfNeeded();
      return sharedAccess(pageInfo);
    }
    case "sharedUnlock":
      return unlockSharedSession(message, sender);
    case "sharedTouch": {
      const pageInfo = await sharedPage(sender);
      if (!pageInfo || !session.vault || !(await sharedSettings(pageInfo))) return { available: false };
      await markActivity();
      return { available: true, unlocked: true, sessionId: session.id,
        expiresAt: session.lastActivity + await autoLockDuration() };
    }
    case "sharedLock": {
      const pageInfo = await sharedPage(sender);
      if (!pageInfo) return { available: false };
      await clearSession();
      return { available: true, unlocked: false };
    }
    case "sharedCommit": {
      const pageInfo = await sharedPage(sender);
      if (!pageInfo || !session.vault) return { available: false };
      const settings = await sharedSettings(pageInfo);
      if (!settings) return { available: false };
      const record = message.record;
      const revision = Number(message.revision);
      if (!VaultSync.validRecord(record) || record.salt !== session.record.salt ||
          !Number.isSafeInteger(revision) || revision < settings.revision) {
        return { available: true, stale: true, revision: settings.revision };
      }
      const value = await PasswordCrypto.decryptWithKey(session.key, record);
      if (!value || value.version !== 1 || !Array.isArray(value.entries)) {
        throw new Error("网页保险库格式无效");
      }
      const localChanged = !VaultSync.same(session.record, settings.baseRecord);
      if (localChanged && !VaultSync.same(session.record, record)) {
        await setSyncStatus("pending", "扩展有未同步修改，等待合并");
        return { available: true, deferred: true, revision: settings.revision };
      }
      session.record = record;
      session.vault = value;
      await extensionApi.storage.local.set({ vaultRecord: record });
      await saveSyncSettings({ ...settings, revision, baseRecord: record,
        lastSyncedAt: new Date().toISOString() });
      await markActivity();
      await setSyncStatus("ok", "已同步");
      return { available: true, revision };
    }
    case "setup": {
      const existing = await storedRecord();
      if (existing) throw new Error("保险库已经存在");
      if (!message.password || message.password.length < 12) {
        throw new Error("主密码至少需要 12 个字符");
      }
      const vault = { version: 1, entries: [] };
      const record = await PasswordCrypto.createRecord(message.password, vault);
      const opened = await PasswordCrypto.openRecord(message.password, record);
      await extensionApi.storage.local.set({ vaultRecord: record });
      await openSession(opened, record);
      return { mode: "unlocked", ephemeral: false };
    }
    case "bootstrapSync": {
      if (await storedRecord()) throw new Error("本机已有保险库，请先在备份页连接服务器");
      const url = VaultSync.endpoint(message.url);
      const token = String(message.token || "").trim();
      if (!/^[0-9a-f]{64}$/.test(token)) throw new Error("服务器令牌格式无效");
      const remote = await remoteVault(url, token);
      if (!remote.record) throw new Error("服务器还没有保险库，请先从第一台设备上传");
      const opened = await PasswordCrypto.openRecord(message.password || "", remote.record);
      if (opened.value?.version !== 1 || !Array.isArray(opened.value.entries)) throw new Error("服务器保险库格式无效");
      await extensionApi.storage.local.set({ vaultRecord: remote.record });
      await openSession(opened, remote.record);
      await saveSyncSettings({ url, token, revision: remote.revision,
        baseRecord: remote.record, lastSyncedAt: new Date().toISOString() });
      await extensionApi.storage.session.remove(SYNC_STATUS);
      await scheduleAutoSync();
      return { mode: "unlocked", count: opened.value.entries.length };
    }
    case "unlock": {
      const record = await storedRecord();
      if (!record) throw new Error("保险库尚未创建");
      const opened = await PasswordCrypto.openRecord(message.password || "", record);
      if (!opened.value || !Array.isArray(opened.value.entries)) throw new Error("保险库格式无效");
      await openSession(opened, record);
      return { mode: "unlocked", ephemeral: false };
    }
    case "importVault": {
      const record = message.record;
      if (!record || !record.iv || !record.ciphertext || (record.version !== 2 && !record.salt)) {
        throw new Error("加密备份格式无效");
      }
      const opened = record?.version === 2
        ? await PasswordCrypto.openRecoveryRecord(message.privateKey, record)
        : await PasswordCrypto.openRecord(message.password || "", record);
      if (!opened.value || !Array.isArray(opened.value.entries)) throw new Error("加密备份内容无效");
      await openSession(opened, record, true);
      return { mode: "unlocked", ephemeral: true };
    }
    case "openPortableRemote": {
      const url = VaultSync.endpoint(message.url);
      const token = String(message.token || "").trim();
      if (!/^[0-9a-f]{64}$/.test(token)) throw new Error("服务器令牌格式无效");
      const remote = await remoteVault(url, token);
      if (!remote.record) throw new Error("服务器还没有保险库");
      const opened = await PasswordCrypto.openRecord(message.password || "", remote.record);
      if (opened.value?.version !== 1 || !Array.isArray(opened.value.entries)) {
        throw new Error("服务器保险库格式无效");
      }
      await openSession(opened, remote.record, true);
      return { mode: "unlocked", ephemeral: true, count: opened.value.entries.length };
    }
    case "exportVault":
      requireUnlocked();
      return { record: session.record, ephemeral: session.ephemeral };
    case "exportRecovery": {
      requireUnlocked();
      return PasswordCrypto.createRecoveryRecord(session.vault);
    }
    case "restoreRecovery": {
      const record = message.record;
      if (!record || !record.iv || !record.ciphertext || (record.version !== 2 && !record.salt)) {
        throw new Error("加密恢复文件格式无效");
      }
      if (!message.newPassword || message.newPassword.length < 12) throw new Error("新主密码至少需要 12 个字符");
      let opened;
      try {
        opened = await PasswordCrypto.openRecoveryRecord(
          record.version === 2 ? message.privateKey : message.password || "", record
        );
      } catch { throw new Error("恢复私钥或旧恢复密码不正确，或文件已损坏"); }
      if (!opened.value || !Array.isArray(opened.value.entries)) throw new Error("恢复文件内容无效");
      const newRecord = await PasswordCrypto.createRecord(message.newPassword, opened.value);
      await extensionApi.storage.local.set({ vaultRecord: newRecord });
      await extensionApi.storage.local.remove(["quickUnlock", "syncSettings"]);
      await extensionApi.storage.session.remove(SYNC_STATUS);
      const newOpened = await PasswordCrypto.openRecord(message.newPassword, newRecord);
      await openSession(newOpened, newRecord, false);
      return { mode: "unlocked", ephemeral: false };
    }
    case "enableQuickUnlock": {
      requireUnlocked();
      if (session.ephemeral) throw new Error("便携模式不能开启设备验证解锁");
      if (!message.credentialId || !message.prfSalt || !message.prfResult) throw new Error("设备验证数据不完整");
      const wrapped = await PasswordCrypto.encryptWithKey(
        await PasswordCrypto.prfKey(message.prfResult),
        { key: await PasswordCrypto.exportKey(session.key) }
      );
      await extensionApi.storage.local.set({ quickUnlock: {
        credentialId: message.credentialId,
        prfSalt: message.prfSalt,
        salt: session.record.salt,
        ...wrapped
      } });
      return { ok: true };
    }
    case "disableQuickUnlock":
      requireUnlocked();
      await extensionApi.storage.local.remove("quickUnlock");
      return { ok: true };
    case "setAutoLock": {
      requireUnlocked();
      if (session.ephemeral) throw new Error("便携模式固定 5 分钟后锁定");
      const minutes = Number(message.minutes);
      if (!AUTO_LOCK_OPTIONS.includes(minutes)) throw new Error("不支持此锁定时长");
      await extensionApi.storage.local.set({ autoLockMinutes: minutes });
      await markActivity();
      return { autoLockMinutes: minutes };
    }
    case "quickUnlock": {
      const record = await storedRecord();
      const quick = (await extensionApi.storage.local.get("quickUnlock")).quickUnlock;
      if (!record || !quick || quick.salt !== record.salt) throw new Error("设备验证解锁未启用");
      try {
        const wrapped = await PasswordCrypto.decryptWithKey(
          await PasswordCrypto.prfKey(message.prfResult), quick
        );
        const key = await PasswordCrypto.importKey(wrapped.key);
        const vault = await PasswordCrypto.decryptWithKey(key, record);
        if (!vault || !Array.isArray(vault.entries)) throw new Error("保险库格式无效");
        await openSession({ key, value: vault }, record);
        return { mode: "unlocked", ephemeral: false };
      } catch {
        throw new Error("设备验证失败，请用主密码解锁");
      }
    }
    case "resetVault":
      await clearSession();
      await extensionApi.storage.local.remove(["vaultRecord", "quickUnlock", "syncSettings"]);
      await extensionApi.storage.session.remove(SYNC_STATUS);
      return { mode: "setup" };
    case "lock":
      await clearSession();
      return { mode: "locked" };
    case "list":
      requireUnlocked();
      await markActivity();
      return { entries: session.vault.entries };
    case "getSyncState": {
      const settings = await syncSettings();
      const status = (await extensionApi.storage.session.get(SYNC_STATUS))[SYNC_STATUS] || null;
      return settings ? { connected: true, url: settings.url, revision: settings.revision,
        lastSyncedAt: settings.lastSyncedAt, status } : { connected: false, status,
        autoConnect: (await extensionApi.storage.local.get("syncAutoConnect")).syncAutoConnect !== false };
    }
    case "getLocalPair":
      return localPair(message.url || (await extensionApi.storage.local.get("localSyncUrl")).localSyncUrl);
    case "connectLocal": {
      requireUnlocked();
      const preferred = (await extensionApi.storage.local.get("localSyncUrl")).localSyncUrl;
      const pair = await localPair(message.url || preferred);
      let result;
      try { result = await connectToSync(pair.url, pair.token); }
      catch (error) {
        if (!mergeRequired(error)) throw error;
        return { needsMerge: true, url: pair.url };
      }
      await extensionApi.storage.local.set({ syncAutoConnect: true, localSyncUrl: pair.url });
      return result;
    }
    case "configureSync": {
      try { return await connectToSync(message.url, message.token); }
      catch (error) {
        if (!mergeRequired(error)) throw error;
        return { needsMerge: true };
      }
    }
    case "previewServerMerge":
      return previewServerMerge(message);
    case "applyServerMerge":
      return applyServerMerge(message);
    case "replaceRemoteAfterRecovery": {
      requireUnlocked();
      if (session.ephemeral || await syncSettings()) throw new Error("请先断开旧连接，并在本机解锁保险库");
      const url = VaultSync.endpoint(message.url);
      const token = String(message.token || "").trim();
      if (!/^[0-9a-f]{64}$/.test(token)) throw new Error("服务器令牌格式无效");
      const remote = await remoteVault(url, token);
      if (!remote.record || remote.record.salt === session.record.salt) {
        throw new Error("服务器并非旧密钥保险库，请使用普通连接");
      }
      const revision = (await remoteVault(url, token, "PUT", {
        expectedRevision: remote.revision, record: session.record
      })).revision;
      await saveSyncSettings({ url, token, revision, baseRecord: session.record,
        lastSyncedAt: new Date().toISOString() });
      await extensionApi.storage.session.remove(SYNC_STATUS);
      await scheduleAutoSync();
      return { connected: true, revision };
    }
    case "syncNow":
      requireUnlocked();
      return runSync(message.decisions || {});
    case "disconnectSync":
      requireUnlocked();
      await extensionApi.storage.local.remove("syncSettings");
      await extensionApi.storage.local.set({ syncAutoConnect: false });
      await extensionApi.storage.session.set({ [SYNC_STATUS]: { kind: "local", message: "仅保存在此浏览器" } });
      await extensionApi.alarms.clear(AUTO_SYNC_ALARM);
      return { connected: false };
    case "saveEntry": {
      requireWritableVault();
      const entry = message.entry || {};
      const normalized = {
        id: entry.id || newId(),
        kind: entry.kind === "app" ? "app" : "site",
        name: String(entry.name || "未命名账号").trim().slice(0, 100),
        site: entry.kind === "app"
          ? String(entry.site || "").trim().toLowerCase().slice(0, 253)
          : PasswordCrypto.normalizeHost(entry.site),
        username: String(entry.username || "").trim().slice(0, 320),
        password: String(entry.password || "").slice(0, 1000),
        subdomains: Boolean(entry.subdomains),
        updatedAt: new Date().toISOString()
      };
      if (!normalized.site || !normalized.username || !normalized.password) {
        throw new Error("网站、用户名和密码都不能为空");
      }
      const index = session.vault.entries.findIndex((item) => item.id === normalized.id ||
        (!entry.id && (item.kind || "site") === normalized.kind && entryTarget(item) === normalized.site &&
          item.username === normalized.username));
      if (index >= 0) {
        const previous = session.vault.entries[index];
        normalized.id = previous.id;
        if (!entry.id && normalized.name === normalized.site) normalized.name = previous.name;
        if (entry.subdomains === undefined) normalized.subdomains = previous.subdomains;
        if ((previous.kind || "site") === normalized.kind && previous.name === normalized.name && previous.site === normalized.site &&
            previous.username === normalized.username && previous.password === normalized.password &&
            previous.subdomains === normalized.subdomains) return { entry: previous, unchanged: true };
        session.vault.entries[index] = normalized;
      }
      else session.vault.entries.unshift(normalized);
      await persistVault();
      await markActivity();
      return { entry: normalized };
    }
    case "importEntries": {
      requireWritableVault();
      if (!Array.isArray(message.entries) || !message.entries.length) throw new Error("没有可导入的账号");
      const conflict = message.conflict === "replace" ? "replace" : "skip";
      let added = 0;
      let updated = 0;
      let skipped = 0;
      for (const entry of message.entries) {
        const normalized = {
          id: newId(),
          kind: "site",
          name: String(entry?.name || "未命名账号").trim().slice(0, 100),
          site: PasswordCrypto.normalizeHost(entry?.site),
          username: String(entry?.username || "").trim().slice(0, 320),
          password: String(entry?.password || "").slice(0, 1000),
          subdomains: false,
          updatedAt: new Date().toISOString()
        };
        if (!normalized.site || !normalized.username || !normalized.password) {
          skipped += 1;
          continue;
        }
        const index = session.vault.entries.findIndex((item) => (
          entryTarget(item) === normalized.site && item.username === normalized.username && (item.kind || "site") === normalized.kind
        ));
        if (index >= 0) {
          if (conflict === "replace") {
            normalized.id = session.vault.entries[index].id;
            session.vault.entries[index] = normalized;
            updated += 1;
          } else {
            skipped += 1;
          }
        } else {
          session.vault.entries.unshift(normalized);
          added += 1;
        }
      }
      await persistVault();
      await markActivity();
      return { added, updated, skipped };
    }
    case "deleteEntry":
      requireWritableVault();
      session.vault.entries = session.vault.entries.filter((item) => item.id !== message.id);
      await persistVault();
      await markActivity();
      return { ok: true };
    case "getMatches": {
      if (!session.vault) return { locked: true, entries: [] };
      const page = pageFromSender(sender);
      if (!page) return { locked: false, unsupported: true, entries: [] };
      const host = page.hostname;
      const entries = session.vault.entries
        .filter((entry) => entry.kind !== "app" && hostMatches(entry.site, host, entry.subdomains))
        .map(({ id, name, site, username }) => ({ id, name, site, username }));
      const insecure = page.protocol === "http:" && !/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(host);
      return { locked: false, insecure, entries };
    }
    case "getEntry": {
      requireUnlocked();
      const page = pageFromSender(sender);
      if (!page) throw new Error("仅 HTTP 和 HTTPS 页面允许填充");
      const host = page.hostname;
      const entry = session.vault.entries.find((item) => item.id === message.id && hostMatches(item.site, host, item.subdomains));
      if (!entry) throw new Error("账号与当前网站不匹配");
      await markActivity();
      return { entry: { ...entry } };
    }
    case "stageLogin": {
      requireUnlocked();
      if (session.ephemeral) return { staged: false };
      const page = pageFromSender(sender);
      if (!page || !sender.tab?.id) throw new Error("仅网页表单支持保存登录信息");
      const username = String(message.username || "").trim().slice(0, 320);
      const password = String(message.password || "").slice(0, 1000);
      const kind = ["login", "register", "change"].includes(message.kind) ? message.kind : "login";
      const currentPassword = kind === "change" ? String(message.currentPassword || "").slice(0, 1000) : "";
      if (!password) throw new Error("没有可保存的密码");
      const payload = await PasswordCrypto.encryptWithKey(session.key, {
        site: PasswordCrypto.normalizeHost(page.hostname), username, password, currentPassword
      });
      await extensionApi.storage.session.set({ [`${PENDING_LOGIN_PREFIX}${sender.tab.id}`]: {
        token: crypto.randomUUID(), salt: session.record.salt, createdAt: Date.now(), ready: false,
        kind, remember: message.remember === true, frameId: sender.frameId || 0,
        path: `${page.pathname}${page.search}`, ...payload
      } });
      await markActivity();
      return { staged: true };
    }
    case "getPendingLogin": {
      if (!session.vault || session.ephemeral || !sender.tab?.id) return { pending: null };
      const pending = await pendingLogin(sender.tab.id);
      if (!pending) return { pending: null };
      if (pending.frameId !== (sender.frameId || 0)) return { pending: null };
      if (message.failureEvidence === true) {
        await extensionApi.storage.session.remove(`${PENDING_LOGIN_PREFIX}${sender.tab.id}`);
        return { pending: null };
      }
      if (!pending.ready) {
        pending.ready = true;
        await extensionApi.storage.session.set({ [`${PENDING_LOGIN_PREFIX}${sender.tab.id}`]: pending });
      }
      const summary = await pendingLoginSummary(sender.tab.id, pending);
      const page = pageFromSender(sender);
      if (!page || PasswordCrypto.normalizeHost(page.hostname) !== summary?.site) return { pending: null };
      const changedPage = `${page.pathname}${page.search}` !== pending.path;
      if (summary.username && (changedPage || message.successEvidence === true)) {
        return commitPendingLogin(sender.tab.id, pending, summary.username);
      }
      return { pending: summary };
    }
    case "getPendingLogins": {
      requireUnlocked();
      if (session.ephemeral) return { pending: [] };
      const stored = await extensionApi.storage.session.get(null);
      const pending = [];
      for (const [key] of Object.entries(stored)) {
        if (!key.startsWith(PENDING_LOGIN_PREFIX)) continue;
        const tabId = Number(key.slice(PENDING_LOGIN_PREFIX.length));
        const record = await pendingLogin(tabId);
        if (!record?.ready) continue;
        const summary = await pendingLoginSummary(tabId, record);
        if (summary) pending.push(summary);
      }
      return { pending };
    }
    case "confirmPendingLogin": {
      requireUnlocked();
      const tabId = trustedPage ? Number(message.tabId) : sender.tab?.id;
      const pending = tabId && await pendingLogin(tabId);
      if (!pending || pending.token !== message.token) throw new Error("待保存的登录信息已过期");
      return commitPendingLogin(tabId, pending, message.username);
    }
    case "discardPendingLogin": {
      const tabId = trustedPage ? Number(message.tabId) : sender.tab?.id;
      const pending = tabId && await pendingLogin(tabId);
      if (pending?.token === message.token) await extensionApi.storage.session.remove(`${PENDING_LOGIN_PREFIX}${tabId}`);
      return { ok: true };
    }
    case "openSuggestion": {
      requireUnlocked();
      const page = pageFromSender(sender);
      if (!page || !sender.tab?.id) throw new Error("仅网页注册表单支持密码建议");
      const raw = message.policy || {};
      const policy = {
        minLength: Number.isInteger(raw.minLength) ? raw.minLength : 12,
        maxLength: Number.isInteger(raw.maxLength) ? raw.maxLength : 64,
        requireUpper: raw.requireUpper === true,
        requireLower: raw.requireLower === true,
        requireDigit: raw.requireDigit === true,
        requireSymbol: raw.requireSymbol === true,
        alphanumericOnly: raw.alphanumericOnly === true
      };
      const token = crypto.randomUUID();
      const context = {
        token, tabId: sender.tab.id, frameId: sender.frameId || 0,
        hostname: page.hostname, insecure: page.protocol === "http:",
        kind: message.kind === "change" ? "change" : "register",
        policy, createdAt: Date.now()
      };
      const previous = await extensionApi.storage.session.get(null);
      const obsolete = Object.entries(previous).filter(([key, value]) => (
        key.startsWith("suggestion:") && (value.tabId === sender.tab.id || Date.now() - value.createdAt > 15 * 60 * 1000)
      )).map(([key]) => key);
      if (obsolete.length) await extensionApi.storage.session.remove(obsolete);
      await extensionApi.storage.session.set({ [`suggestion:${token}`]: context });
      try {
        await extensionApi.windows.create({
          url: extensionApi.runtime.getURL(`suggest.html#${token}`),
          type: "popup", width: 420, height: 550
        });
      } catch (error) {
        await extensionApi.storage.session.remove(`suggestion:${token}`);
        throw error;
      }
      return { token };
    }
    case "getSuggestionContext": {
      requireUnlocked();
      const context = await suggestionContext(message.token);
      const sources = session.vault.entries.map(({ id, name, site, username }) => ({ id, name, site, username }));
      const accounts = session.vault.entries
        .filter((entry) => hostMatches(entry.site, context.hostname, entry.subdomains))
        .map(({ id, name, site, username }) => ({ id, name, site, username }));
      await markActivity();
      return { hostname: context.hostname, insecure: context.insecure, kind: context.kind, policy: context.policy, sources, accounts };
    }
    case "createSuggestion": {
      requireUnlocked();
      const context = await suggestionContext(message.token);
      const reference = message.mode === "reference";
      if (message.mode !== "random" && !reference) throw new Error("未知的建议方式");
      const source = reference && session.vault.entries.find((entry) => entry.id === message.sourceId);
      if (reference && !source) throw new Error("请选择一个参考账号");
      for (let attempt = 0; attempt < 16; attempt++) {
        const password = PasswordCrypto.suggestedPassword(context.policy, source?.password, context.hostname);
        if (session.vault.entries.some((entry) => entry.password === password)) {
          if (reference) throw new Error("易记建议与已存密码重复，请使用独立随机密码或手动调整");
          continue;
        }
        const check = await messageToSuggestionTab(context, "checkSuggestion", password);
        if (check?.valid) {
          await markActivity();
          return { password };
        }
        if (check?.error) throw new Error(check.error);
        if (reference) throw new Error("易记建议未符合网站的完整规则，请换用独立随机密码或手动设置");
      }
      throw new Error("未找到符合此网站规则的建议，请按页面提示手动调整");
    }
    case "applySuggestion": {
      requireUnlocked();
      const context = await suggestionContext(message.token);
      const password = String(message.password || "");
      if (password.length < 8 || password.length > 64) throw new Error("建议密码长度无效");
      const account = context.kind === "change" && message.accountId
        ? session.vault.entries.find((entry) => entry.id === message.accountId && hostMatches(entry.site, context.hostname, entry.subdomains))
        : null;
      if (context.kind === "change" && message.accountId && !account) throw new Error("要修改的账号与当前网站不匹配");
      const result = await messageToSuggestionTab(context, "applySuggestion", password, account?.password || "");
      if (!result?.ok) throw new Error(result?.error || "无法填入页面");
      await markActivity();
      return { ok: true };
    }
    case "updateSuggestedEntry": {
      requireUnlocked();
      const context = await suggestionContext(message.token);
      if (context.kind !== "change") throw new Error("当前不是修改密码场景");
      const entry = session.vault.entries.find((item) => item.id === message.accountId && hostMatches(item.site, context.hostname, item.subdomains));
      if (!entry) throw new Error("要更新的账号与当前网站不匹配");
      const password = String(message.password || "");
      if (password.length < 8 || password.length > 64) throw new Error("新密码长度无效");
      if (entry.password === password) return { ok: true, unchanged: true };
      entry.password = password;
      entry.updatedAt = new Date().toISOString();
      await persistVault();
      await markActivity();
      return { ok: true };
    }
    case "generatePassword":
      return { password: PasswordCrypto.generatePassword(Number(message.length) || 24) };
    default:
      throw new Error("未知请求");
  }
}

if (extensionApi.alarms?.onAlarm) {
  extensionApi.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== AUTO_LOCK_ALARM && alarm.name !== AUTO_SYNC_ALARM) return;
    const task = requestQueue.then(async () => {
      await (sessionReady ||= restoreSession());
      if (await expireIfNeeded()) return;
      if (alarm.name === AUTO_SYNC_ALARM) {
        if (!session.vault || session.ephemeral) return;
        try {
          if (await syncSettings()) await runSync();
          else {
            await setSyncStatus("connecting", "正在查找本机服务…");
            const preferred = (await extensionApi.storage.local.get("localSyncUrl")).localSyncUrl;
            const pair = await localPair(preferred);
            await connectToSync(pair.url, pair.token);
          }
        } catch (error) {
          const connected = await syncSettings().catch(() => null);
          await setSyncStatus(connected ? syncErrorKind(error) : "offline",
            error.message || "本机服务未连接");
        }
        await scheduleAutoSync(5 * 60 * 1000);
      } else if (session.vault) {
        await extensionApi.alarms.create(AUTO_LOCK_ALARM, { when: session.lastActivity + await autoLockDuration() });
      }
    });
    requestQueue = task.catch(() => {});
    return task;
  });
}

extensionApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const task = requestQueue.then(() => handleMessage(message, sender));
  requestQueue = task.catch(() => {});
  if (promiseMessages) return task.catch((error) => ({ error: error.message || "操作失败" }));
  task
    .then(sendResponse)
    .catch((error) => sendResponse({ error: error.message || "操作失败" }));
  return true;
});

if (extensionApi.contextMenus?.create && extensionApi.contextMenus?.onClicked) {
  extensionApi.runtime.onInstalled?.addListener(() => {
    const created = extensionApi.contextMenus.create({
      id: "password-vault-fill",
      title: "从密码匣填充",
      contexts: ["editable"]
    });
    created?.catch?.(() => {});
  });
  extensionApi.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== "password-vault-fill" || !tab?.id || !extensionApi.tabs?.sendMessage) return;
    extensionApi.tabs.sendMessage(tab.id, { type: "openPicker" })?.catch?.(() => {});
  });
}
