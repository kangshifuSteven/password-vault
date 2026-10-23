const promiseMessages = Boolean(globalThis.browser &&
  globalThis.browser.runtime.getURL("").startsWith("moz-extension:"));
const extensionApi = promiseMessages ? globalThis.browser : (globalThis.chrome || globalThis.browser);
const $ = (id) => document.getElementById(id);
let currentEntries = [];
let editingId = null;
let pendingImport = null;
let currentMode = null;
let accessMode = "local";
let currentEphemeral = false;
let activeTab = "accounts";
let quickUnlockState = null;
let auditOpen = false;
let pendingLogins = [];
let seenSyncRevision = null;
let mergeEndpoint = null;
let mergePreviewRevision = null;
let guideStep = 0;
let pendingRecoveryRecord = null;
let pendingRecoveryPrivateKey = null;
const guideSteps = [
  { title: "先做恢复备份", description: "在“备份”页生成恢复文件，并把私钥单独保存。只靠同步服务，忘记主密码也无法解密。" },
  { title: "把账号放进来", description: "“添加”保存单个网站或 App；“导入”处理浏览器导出的 CSV。导入后核对账号。" },
  { title: "按需连接同步", description: "“同步”连接自己的服务。两边已有账号时先预览合并；之后修改会自动同步。" }
];

function renderFirstRunGuide() {
  const step = guideSteps[guideStep];
  $("guideProgress").textContent = `首次使用 ${guideStep + 1}/${guideSteps.length}`;
  $("guideTitle").textContent = step.title;
  $("guideDescription").textContent = step.description;
  $("guideNext").textContent = guideStep === guideSteps.length - 1 ? "完成" : "下一步";
}

async function closeFirstRunGuide() {
  await extensionApi.storage.local.set({ guidePending: false });
  $("firstRunGuide").hidden = true;
  $("unlockedView").classList.remove("onboarding");
}

function toBase64(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function fromBase64(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

async function getPrfResult(credentialId, salt) {
  const credential = await navigator.credentials.get({ publicKey: {
    challenge: randomBytes(32),
    allowCredentials: [{ type: "public-key", id: fromBase64(credentialId) }],
    userVerification: "required",
    extensions: { prf: { eval: { first: fromBase64(salt) } } }
  } });
  const result = credential?.getClientExtensionResults()?.prf?.results?.first;
  if (!result || result.byteLength !== 32) throw new Error("此设备不支持安全的快速解锁，请使用主密码");
  return toBase64(result);
}

function send(message) {
  if (promiseMessages) {
    return extensionApi.runtime.sendMessage(message)
      .catch((error) => ({ error: error.message || "扩展未响应" }));
  }
  return new Promise((resolve) => {
    try {
      extensionApi.runtime.sendMessage(message, (response) => {
        resolve(extensionApi.runtime.lastError ? { error: extensionApi.runtime.lastError.message } : (response || { error: "扩展未响应" }));
      });
    } catch (error) {
      resolve({ error: error.message || "扩展未响应" });
    }
  });
}

function showNotice(message = "", tone = "info") {
  $("notice").textContent = message;
  $("notice").dataset.tone = tone;
}

function setTab(tab) {
  if (activeTab === "entry" && tab !== "entry") setEntryPasswordVisible(false);
  if (activeTab === "import" && tab !== "import") closeImportPanel();
  if (activeTab === "backup" && tab !== "backup") closeBackupPanel();
  if (tab !== "accounts" && auditOpen) {
    auditOpen = false;
    renderEntries();
  }
  activeTab = tab;
  for (const [name, buttonId, paneId] of [
    ["accounts", "accountsButton", "accountsPane"],
    ["entry", "addButton", "entryPane"],
    ["import", "importButton", "importPane"],
    ["backup", "exportButton", "backupPane"],
    ["sync", "syncButton", "syncPane"]
  ]) {
    $(buttonId).setAttribute("aria-selected", String(name === tab));
    $(buttonId).tabIndex = name === tab ? 0 : -1;
    $(paneId).hidden = name !== tab;
  }
}

function setAccessMode(mode) {
  accessMode = mode === "portable" ? "portable" : "local";
  const awaitingUnlock = currentMode === "setup" || currentMode === "locked";
  $("accessModeSwitch").hidden = !awaitingUnlock;
  $("localModeButton").setAttribute("aria-pressed", String(accessMode === "local"));
  $("portableModeButton").setAttribute("aria-pressed", String(accessMode === "portable"));
  $("setupView").hidden = currentMode !== "setup" || accessMode !== "local";
  $("lockedView").hidden = currentMode !== "locked" || accessMode !== "local";
  $("recoveryTools").hidden = !awaitingUnlock || accessMode !== "local";
  $("portableView").hidden = !awaitingUnlock || accessMode !== "portable";
}

function setView(mode, ephemeral = false) {
  const wasUnlocked = currentMode === "unlocked";
  if (mode !== "unlocked" && currentMode === "unlocked") {
    currentEntries = [];
    pendingLogins = [];
    $("pendingLoginPanel").hidden = true;
    auditOpen = false;
    resetEntryForm();
    closeImportPanel();
    closeBackupPanel();
    $("entryList").replaceChildren();
    $("auditList").replaceChildren();
    $("auditSummary").textContent = "";
    $("auditView").hidden = true;
    $("accountsListView").hidden = false;
    $("searchInput").value = "";
    $("syncToken").value = "";
  }
  currentMode = mode;
  currentEphemeral = mode === "unlocked" && ephemeral;
  if (mode === "unlocked") accessMode = ephemeral ? "portable" : "local";
  $("updateView").hidden = mode !== "update";
  setAccessMode(accessMode);
  $("resetVaultButton").hidden = mode !== "locked";
  $("unlockedView").hidden = mode !== "unlocked";
  $("unlockedView").classList.toggle("portable", currentEphemeral);
  $("lockButton").hidden = mode !== "unlocked";
  $("auditButton").hidden = currentEphemeral;
  $("syncIndicator").hidden = currentEphemeral;
  const badge = $("statusBadge");
  badge.className = `status-badge ${mode}`;
  badge.textContent = mode === "setup" ? "未初始化" : mode === "locked" ? "已锁定" : mode === "update" ? "需重新加载" : "已解锁";
  $("sessionHint").hidden = mode !== "unlocked" || !ephemeral;
  $("quickUnlockButton").hidden = mode !== "locked" || !quickUnlockState?.quickUnlock;
  $("quickUnlockPanel").hidden = mode !== "unlocked" || ephemeral;
  $("enableQuickUnlock").hidden = Boolean(quickUnlockState?.quickUnlock);
  $("disableQuickUnlock").hidden = !quickUnlockState?.quickUnlock;
  if (mode === "unlocked" && !wasUnlocked) setTab("accounts");
}

function resetEntryForm() {
  editingId = null;
  $("entryForm").reset();
  setEntryPasswordVisible(false);
  $("formTitle").textContent = "添加账号";
  $("cancelEdit").hidden = true;
  document.querySelectorAll('input[name="entryKind"]').forEach((radio) => { radio.checked = radio.value === "site"; });
  updateEntryKind();
}

function entryKind() {
  return document.querySelector('input[name="entryKind"]:checked')?.value === "app" ? "app" : "site";
}

function updateEntryKind() {
  const app = entryKind() === "app";
  $("entrySiteLabel").textContent = app ? "App 名称" : "网站";
  $("entrySite").placeholder = app ? "例如：微信、企业微信" : "example.com";
  $("entrySubdomains").closest(".checkbox-label").hidden = app;
}

function setEntryPasswordVisible(visible) {
  const label = visible ? "隐藏密码" : "显示密码";
  $("entryPassword").type = visible ? "text" : "password";
  $("toggleEntryPassword").setAttribute("aria-label", label);
  $("toggleEntryPassword").setAttribute("aria-pressed", String(visible));
  $("toggleEntryPassword").title = label;
  $("entryEye").toggleAttribute("hidden", visible);
  $("entryEyeOff").toggleAttribute("hidden", !visible);
}

function renderEntries() {
  const groups = new Map();
  for (const entry of currentEntries) {
    const matches = groups.get(entry.password) || [];
    matches.push(entry);
    groups.set(entry.password, matches);
  }
  const reused = [...groups.values()].filter((entries) => entries.length > 1).sort((a, b) => b.length - a.length);
  const reusedCount = reused.reduce((sum, entries) => sum + entries.length, 0);
  $("accountCount").textContent = `${currentEntries.length} 个账号`;
  $("auditButton").textContent = reusedCount ? `重复密码 ${reusedCount}` : "检查重复密码";
  $("auditButton").classList.toggle("has-risk", reusedCount > 0);
  $("accountsListView").hidden = auditOpen;
  $("auditView").hidden = !auditOpen;
  $("auditSummary").textContent = reusedCount
    ? `${reusedCount} 个账号共用 ${reused.length} 组密码。改密后会尝试自动更新。`
    : "未发现重复使用的密码。";
  const auditList = $("auditList");
  auditList.replaceChildren();
  for (const entries of reused) {
    const group = document.createElement("section");
    group.className = "audit-group";
    const heading = document.createElement("strong");
    heading.textContent = `${entries.length} 个账号共用同一密码`;
    const list = document.createElement("div");
    list.className = "audit-accounts";
    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = "audit-account";
      const identity = document.createElement("div");
      identity.className = "audit-identity";
      const site = document.createElement("strong");
      site.className = "audit-site";
      site.textContent = `${entry.kind === "app" ? "App" : "网站"}：${entry.kind === "app" ? entry.site : PasswordCrypto.normalizeHost(entry.site)}`;
      const username = document.createElement("span");
      username.textContent = `登录账号：${entry.username}`;
      identity.append(site, username);
      const name = String(entry.name || "").trim();
      if (name && PasswordCrypto.normalizeHost(name) !== PasswordCrypto.normalizeHost(entry.site)) {
        const label = document.createElement("span");
        label.textContent = `名称：${name}`;
        identity.appendChild(label);
      }
      const edit = document.createElement("button");
      edit.className = "text-button";
      edit.type = "button";
      edit.textContent = "修改";
      edit.setAttribute("aria-label", `修改 ${entry.site} 的 ${entry.username}`);
      edit.addEventListener("click", () => editEntry(entry));
      row.append(identity);
      if (!currentEphemeral) row.append(edit);
      list.appendChild(row);
    }
    group.append(heading, list);
    auditList.appendChild(group);
  }
  const query = $("searchInput").value.trim().toLowerCase();
  const entries = currentEntries.filter((entry) => `${entry.name} ${entry.site} ${entry.username}`.toLowerCase().includes(query));
  const list = $("entryList");
  list.innerHTML = "";
  $("emptyState").hidden = currentEntries.length > 0;
  if (!currentEntries.length) return;
  if (!entries.length) {
    list.innerHTML = '<div class="empty-state"><strong>没有匹配项</strong><span>试试网站名称或用户名。</span></div>';
    return;
  }
  entries.forEach((entry) => {
    const card = document.createElement("article");
    card.className = "entry-card";
    const main = document.createElement("div");
    main.className = "entry-main";
    const name = document.createElement("div");
    name.className = "entry-name";
    name.textContent = entry.name;
    const meta = document.createElement("div");
    meta.className = "entry-meta";
    meta.textContent = `${entry.kind === "app" ? "App" : entry.site} · ${entry.username}`;
    main.append(name, meta);
    const actions = document.createElement("div");
    actions.className = "entry-actions";
    actions.classList.toggle("portable", currentEphemeral);
    const copyUser = document.createElement("button");
    copyUser.type = "button";
    copyUser.textContent = "复制账号";
    copyUser.addEventListener("click", () => copy(entry.username, "账号已复制"));
    const copyPass = document.createElement("button");
    copyPass.type = "button";
    copyPass.textContent = "复制密码";
    copyPass.addEventListener("click", () => copy(entry.password, "密码已复制，请及时清空剪贴板", true));
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "编辑";
    edit.addEventListener("click", () => editEntry(entry));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "删除";
    remove.addEventListener("click", async () => {
      if (!confirm(`删除“${entry.name}”？此操作无法恢复。`)) return;
      const result = await send({ type: "deleteEntry", id: entry.id });
      if (showActionError(result)) return;
      if (editingId === entry.id) resetEntryForm();
      showNotice("账号已删除");
      await refresh();
    });
    actions.append(copyUser, copyPass);
    const siteUrl = entry.kind === "app" ? "" : PasswordCrypto.siteUrl(entry.site);
    if (siteUrl) {
      const open = document.createElement("button");
      open.type = "button";
      open.textContent = "打开网站";
      open.title = "以 HTTPS 打开网站";
      open.addEventListener("click", async () => {
        try { await extensionApi.tabs.create({ url: siteUrl }); }
        catch { showNotice("无法打开网站", "error"); }
      });
      actions.classList.add("has-site");
      actions.append(open);
    }
    if (!currentEphemeral) actions.append(edit, remove);
    card.append(main, actions);
    list.appendChild(card);
  });
}

function renderPendingLogins() {
  const pending = pendingLogins[0];
  $("pendingLoginPanel").hidden = !pending || currentEphemeral;
  if (!pending) return;
  $("pendingCount").textContent = pendingLogins.length > 1 ? `${pendingLogins.length} 项` : "";
  $("pendingSite").textContent = pending.site;
  $("pendingUsername").value = pending.username;
  $("pendingSave").textContent = pending.action === "update" ? "更新" : "保存";
}

function importKey(entry) {
  return `${PasswordCrypto.normalizeHost(entry.site)}\u0000${String(entry.username || "").trim()}`;
}

function browserPasswordSettings() {
  const edge = /\bEdg(?:e|A|iOS)?\//.test(navigator.userAgent);
  return edge
    ? { name: "Edge", label: "打开 Edge 密码管理器", url: "edge://settings/autofill/passwords", hint: "打开 Edge 密码列表后，在“…”菜单选择“导出密码”；完成设备验证并保存 CSV，再回到这里。", cleanupUrl: "edge://settings/clearBrowserData", cleanupHint: "核对导入账号并保存加密备份后，在清理页选择“密码”，检查时间范围；开启同步时也可能影响其他设备。" }
    : { name: "Chrome", label: "打开 Chrome 密码设置", url: "chrome://password-manager/settings", hint: "打开 Google 密码管理工具的“设置”后，在“导出密码”旁点击“下载文件”；完成设备验证并保存 CSV，再回到这里。", cleanupUrl: "chrome://password-manager/settings", cleanupHint: "核对导入账号并保存加密备份后再删除。Chrome 的“删除所有数据”还会删除通行密钥，并可能影响同步设备。" };
}

function resetImportPreview() {
  pendingImport = null;
  $("importReview").hidden = true;
  $("importSummary").textContent = "";
}

function closeImportPanel() {
  resetImportPreview();
  $("importPanel").hidden = true;
  $("importFile").value = "";
  return extensionApi.storage.session.remove("importFlow");
}

function closeBackupPanel() {
  $("backupPanel").hidden = true;
  pendingRecoveryRecord = null;
  pendingRecoveryPrivateKey = null;
  $("savedPrivateKey").checked = false;
  $("savedPrivateKey").disabled = true;
  $("downloadRecovery").disabled = true;
  $("recoveryKeyPanel").hidden = true;
  $("confirmBackup").hidden = false;
}

async function updateRecoveryInput(fileInput, privateLabel, passwordLabel, privateInput, passwordInput) {
  let modern = false;
  try { modern = JSON.parse(await $(fileInput).files[0].text()).version === 2; }
  catch { /* Invalid files are reported when submitted. */ }
  $(privateLabel).hidden = !modern;
  $(passwordLabel).hidden = modern;
  $(privateInput).required = modern;
  $(passwordInput).required = !modern;
  if (modern) $(passwordInput).value = "";
  else $(privateInput).value = "";
}

function downloadJson(value, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function prepareImport(parsed) {
  const seen = new Set();
  const entries = [];
  let skipped = Number(parsed.skipped) || 0;
  for (const entry of parsed.entries) {
    const key = importKey(entry);
    if (!key.startsWith("\u0000") && !seen.has(key)) {
      seen.add(key);
      entries.push(entry);
    } else {
      skipped += 1;
    }
  }
  const existing = new Set(currentEntries.map(importKey));
  const updated = entries.filter((entry) => existing.has(importKey(entry))).length;
  pendingImport = { entries, skipped, added: entries.length - updated, updated };
  $("importSummary").textContent = `读取 ${parsed.total} 条：新增 ${pendingImport.added}，重复 ${pendingImport.updated}，跳过 ${pendingImport.skipped}`;
  $("importPanel").hidden = false;
  $("importReview").hidden = false;
  $("replaceImport").disabled = !entries.length;
  $("skipImport").disabled = !entries.length;
}

async function readImportFile(file) {
  if (!file) return;
  resetImportPreview();
  if (file.size > 10 * 1024 * 1024) return showNotice("CSV 文件不能超过 10 MB", "error");
  try {
    prepareImport(PasswordCsv.parse(await file.text()));
    showNotice();
  } catch (error) {
    showNotice(error.message || "无法读取 CSV 文件", "error");
  }
}

async function applyImport(conflict) {
  if (!pendingImport?.entries.length) return;
  const result = await send({ type: "importEntries", entries: pendingImport.entries, conflict });
  if (showActionError(result)) return;
  resetImportPreview();
  $("importFile").value = "";
  await extensionApi.storage.session.remove("importFlow");
  showNotice(`已导入 ${result.added} 个账号${result.updated ? `，更新 ${result.updated} 个` : ""}${result.skipped ? `，跳过 ${result.skipped} 个` : ""}`);
  await refresh();
}

async function copy(value, message) {
  try {
    await navigator.clipboard.writeText(value);
    showNotice(message);
    setTimeout(() => showNotice(), 2500);
  } catch {
    showNotice("复制失败，请检查浏览器权限", "error");
  }
}

function editEntry(entry) {
  setEntryPasswordVisible(false);
  editingId = entry.id;
  $("formTitle").textContent = "编辑账号";
  $("cancelEdit").hidden = false;
  $("entryName").value = entry.name;
  document.querySelectorAll('input[name="entryKind"]').forEach((radio) => { radio.checked = radio.value === (entry.kind === "app" ? "app" : "site"); });
  $("entrySite").value = entry.site;
  $("entryUsername").value = entry.username;
  $("entryPassword").value = entry.password;
  $("entrySubdomains").checked = Boolean(entry.subdomains);
  updateEntryKind();
  setTab("entry");
  $("entryName").focus();
}

async function refresh() {
  const state = await send({ type: "getState" });
  if (state.error) {
    showNotice(state.error, "error");
    return;
  }
  if (state.extensionVersion !== extensionApi.runtime.getManifest().version) {
    setView("update");
    return;
  }
  quickUnlockState = state;
  setView(state.mode, state.ephemeral);
  if (state.mode === "unlocked") {
    const { guidePending } = await extensionApi.storage.local.get("guidePending");
    $("firstRunGuide").hidden = state.ephemeral || !guidePending;
    $("unlockedView").classList.toggle("onboarding", Boolean(guidePending && !state.ephemeral));
    if (guidePending && !state.ephemeral) renderFirstRunGuide();
    $("autoLockMinutes").value = String(state.autoLockMinutes);
    const result = await send({ type: "list" });
    if (result.error) {
      setView("locked");
      return showNotice("密码匣已锁定，请重新解锁");
    }
    currentEntries = result.entries || [];
    renderEntries();
    const pending = await send({ type: "getPendingLogins" });
    pendingLogins = pending.pending || [];
    renderPendingLogins();
    if (state.ephemeral) {
      $("syncUnavailable").hidden = false;
      $("syncSetup").hidden = true;
      $("syncConnected").hidden = true;
    } else {
      $("syncUnavailable").hidden = true;
      await renderSyncState();
    }
    const { importFlow } = await extensionApi.storage.session.get("importFlow");
    if (importFlow && !state.ephemeral) {
      $("importPanel").hidden = false;
      setTab("import");
    }
  }
}

async function renderSyncState() {
  const result = await send({ type: "getSyncState" });
  if (showActionError(result)) return;
  $("syncSetup").hidden = result.connected;
  $("syncConnected").hidden = !result.connected;
  if (!result.connected) {
    seenSyncRevision = null;
    const kind = result.status?.kind;
    const label = { connecting: "连接中", offline: "离线", error: "连接失败" }[kind];
    $("syncIndicator").textContent = label || (result.autoConnect ? "本机未同步" : "仅本机");
    $("syncLocalStatus").textContent = result.status?.message ||
      (result.autoConnect ? "解锁后自动查找本机服务" : "自动连接已关闭；点击下方按钮可重新连接");
    return;
  }
  const kind = result.status?.kind;
  $("syncIndicator").textContent = {
    connecting: "连接中", syncing: "同步中", offline: "离线", error: "同步失败",
    conflict: "待处理冲突", pending: "待同步", ok: "已同步"
  }[kind] || "已连接";
  if (seenSyncRevision !== null && seenSyncRevision !== result.revision) {
    const entries = await send({ type: "list" });
    if (!entries.error) { currentEntries = entries.entries || []; renderEntries(); }
  }
  seenSyncRevision = result.revision;
  $("syncHost").textContent = result.url;
  $("syncRevision").textContent = `服务器版本 ${result.revision}`;
  $("syncLast").textContent = result.lastSyncedAt
    ? `上次同步：${new Date(result.lastSyncedAt).toLocaleString()}` : "尚未同步";
  $("syncStatus").hidden = !result.status || result.status.kind === "ok";
  $("syncStatus").textContent = result.status?.kind === "offline"
    ? `服务暂时离线：${result.status.message || "本机更改仍保存在本机，恢复后自动重试"}`
    : result.status?.message || "";
  renderSyncConflicts(result.status?.conflicts || []);
}

function renderSyncConflicts(conflicts) {
  const list = $("syncConflictList");
  list.replaceChildren();
  $("syncConflicts").hidden = !conflicts.length;
  for (const conflict of conflicts) {
    const row = document.createElement("div");
    row.className = "sync-conflict";
    row.dataset.id = conflict.id;
    const label = document.createElement("strong");
    label.textContent = conflict.local?.name || conflict.remote?.name || "已删除的账号";
    const context = document.createElement("span");
    const entry = conflict.local || conflict.remote;
    context.textContent = `${entry?.site || ""} · ${entry?.username || ""}`;
    const choice = document.createElement("select");
    choice.setAttribute("aria-label", `${label.textContent}的冲突处理`);
    for (const [value, text] of [
      ["local", conflict.local ? "保留本机" : "按本机删除"],
      ["remote", conflict.remote ? "保留服务器" : "按服务器删除"],
      ...(conflict.local && conflict.remote ? [["both", "两份都保留"]] : [])
    ]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      choice.appendChild(option);
    }
    row.append(label, context, choice);
    list.appendChild(row);
  }
}

async function runSync(decisions = {}) {
  showNotice();
  $("syncNow").disabled = true;
  $("syncResolve").disabled = true;
  try {
    const result = await send({ type: "syncNow", decisions });
    if (showActionError(result)) return;
    if (result.status === "conflict") {
      renderSyncConflicts(result.conflicts);
      showNotice("请选择每个冲突账号要保留的版本");
      return;
    }
    renderSyncConflicts([]);
    showNotice({ unchanged: "两端已是最新", uploaded: "已上传本机更改", downloaded: "已取回服务器更改",
      merged: "已合并两端更改" }[result.status] || "同步完成");
    await refresh();
  } finally {
    $("syncNow").disabled = false;
    $("syncResolve").disabled = false;
  }
}

async function checkLockState() {
  if (currentMode !== "unlocked" || document.hidden) return;
  const state = await send({ type: "getState" });
  if (state.extensionVersion !== extensionApi.runtime.getManifest().version) {
    setView("update");
    return;
  }
  if (state.mode !== "unlocked") {
    quickUnlockState = state;
    setView(state.mode || "locked");
    showNotice("密码匣已锁定，请重新解锁");
  }
}

function showActionError(result) {
  if (!result.error) return false;
  if (result.error === "LOCKED") {
    setView("locked");
    showNotice("密码匣已锁定，请重新解锁");
  } else {
    showNotice(result.error, "error");
  }
  return true;
}

$("setupForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  showNotice();
  if ($("setupPassword").value !== $("setupConfirm").value) return showNotice("两次输入的主密码不一致", "error");
  const result = await send({ type: "setup", password: $("setupPassword").value });
  if (result.error) return showNotice(result.error, "error");
  await extensionApi.storage.local.set({ guidePending: true });
  $("setupForm").reset();
  showNotice("保险库已创建，建议立即导出加密恢复备份");
  await refresh();
  setTab("backup");
  $("backupPanel").hidden = false;
  $("confirmBackup").focus();
});

$("bootstrapSyncForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = await send({ type: "bootstrapSync", url: $("bootstrapUrl").value,
    token: $("bootstrapToken").value, password: $("bootstrapPassword").value });
  if (showActionError(result)) return;
  await extensionApi.storage.local.set({ guidePending: true });
  $("bootstrapSyncForm").reset();
  showNotice(`已从服务器取回 ${result.count} 个账号`);
  await refresh();
});

$("bootstrapLocalForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("bootstrapLocalForm").querySelector("button");
  button.disabled = true;
  try {
    const pair = await send({ type: "getLocalPair" });
    if (showActionError(pair)) return;
    const result = await send({ type: "bootstrapSync", ...pair,
      password: $("bootstrapLocalPassword").value });
    if (showActionError(result)) return;
    await extensionApi.storage.local.set({ guidePending: true });
    $("bootstrapLocalForm").reset();
    showNotice(`已从本机服务取回 ${result.count} 个账号`);
    await refresh();
  } finally { button.disabled = false; }
});

$("ephemeralForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  showNotice();
  const file = $("ephemeralFile").files[0];
  if (!file) return showNotice("请选择加密备份文件", "error");
  try {
    const record = JSON.parse(await file.text());
    if (record.version === 2) return showNotice("临时使用请导入加密密码文件，不要在临时电脑使用恢复私钥", "error");
    const result = await send({ type: "importVault", record,
      password: $("ephemeralPassword").value });
    if (result.error) return showNotice(result.error, "error");
    $("ephemeralForm").reset();
    await refresh();
  } catch {
    showNotice("无法读取加密密码文件", "error");
  }
});
$("portableRemoteForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  showNotice();
  const result = await send({ type: "openPortableRemote", url: $("portableRemoteUrl").value,
    token: $("portableRemoteToken").value, password: $("portableRemotePassword").value });
  if (showActionError(result)) return;
  $("portableRemoteForm").reset();
  await refresh();
});
for (const radio of document.querySelectorAll('input[name="portableSource"]')) {
  radio.addEventListener("change", () => {
    const remote = document.querySelector('input[name="portableSource"]:checked')?.value === "server";
    $("ephemeralForm").hidden = remote;
    $("portableRemoteForm").hidden = !remote;
    showNotice();
  });
}
$("localModeButton").addEventListener("click", () => { setAccessMode("local"); showNotice(); });
$("portableModeButton").addEventListener("click", () => { setAccessMode("portable"); showNotice(); });
$("recoveryFile").addEventListener("change", () => updateRecoveryInput(
  "recoveryFile", "recoveryPrivateKeyLabel", "recoveryPasswordLabel",
  "recoveryPrivateKeyFile", "recoveryPassword"));

$("unlockForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  showNotice();
  const result = await send({ type: "unlock", password: $("unlockPassword").value });
  if (result.error) return showNotice("主密码不正确，或保险库已损坏", "error");
  $("unlockForm").reset();
  await refresh();
});

$("quickUnlockButton").addEventListener("click", async () => {
  if (!quickUnlockState?.quickCredentialId || !quickUnlockState.quickPrfSalt) return;
  $("quickUnlockButton").disabled = true;
  showNotice();
  try {
    const prfResult = await getPrfResult(quickUnlockState.quickCredentialId, quickUnlockState.quickPrfSalt);
    const result = await send({ type: "quickUnlock", prfResult });
    if (showActionError(result)) return;
    await refresh();
  } catch (error) {
    showNotice(error.name === "NotAllowedError" ? "设备验证已取消，请使用主密码解锁" : (error.message || "设备验证失败，请使用主密码解锁"), "error");
  } finally {
    $("quickUnlockButton").disabled = false;
  }
});

$("enableQuickUnlock").addEventListener("click", async () => {
  $("enableQuickUnlock").disabled = true;
  showNotice();
  try {
    if (!navigator.credentials?.create || !navigator.credentials?.get) throw new Error("此浏览器不支持设备验证");
    const salt = randomBytes(32);
    const credential = await navigator.credentials.create({ publicKey: {
      challenge: randomBytes(32),
      rp: { name: "密码匣" },
      user: { id: randomBytes(16), name: "password-vault", displayName: "密码匣" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "required", userVerification: "required" },
      attestation: "none",
      extensions: { prf: { eval: { first: salt } } }
    } });
    if (!credential?.getClientExtensionResults()?.prf?.enabled) {
      throw new Error("此设备暂不支持安全的设备验证解锁");
    }
    const credentialId = toBase64(credential.rawId);
    const prfSalt = toBase64(salt);
    const prfResult = credential.getClientExtensionResults().prf.results?.first
      ? toBase64(credential.getClientExtensionResults().prf.results.first)
      : await getPrfResult(credentialId, prfSalt);
    const result = await send({ type: "enableQuickUnlock", credentialId, prfSalt, prfResult });
    if (showActionError(result)) return;
    showNotice("设备验证解锁已开启");
    await refresh();
  } catch (error) {
    showNotice(error.name === "NotAllowedError" ? "设备验证已取消" : (error.message || "无法开启设备验证解锁"), "error");
  } finally {
    $("enableQuickUnlock").disabled = false;
  }
});

$("disableQuickUnlock").addEventListener("click", async () => {
  const result = await send({ type: "disableQuickUnlock" });
  if (showActionError(result)) return;
  showNotice("设备验证解锁已关闭");
  await refresh();
});

$("autoLockMinutes").addEventListener("change", async () => {
  const minutes = Number($("autoLockMinutes").value);
  const result = await send({ type: "setAutoLock", minutes });
  if (showActionError(result)) return refresh();
  showNotice(`${minutes} 分钟无操作后锁定`);
});

$("lockButton").addEventListener("click", async () => {
  await send({ type: "lock" });
  resetEntryForm();
  await refresh();
});

$("accountsButton").addEventListener("click", () => setTab("accounts"));
$("auditButton").addEventListener("click", () => {
  auditOpen = true;
  renderEntries();
});
$("auditBack").addEventListener("click", () => {
  auditOpen = false;
  renderEntries();
});
$("addButton").addEventListener("click", () => {
  resetEntryForm();
  setTab("entry");
});
$("unlockedView").querySelector(".view-tabs").addEventListener("keydown", (event) => {
  const tabs = [$("accountsButton"), $("addButton"), $("importButton"), $("exportButton"), $("syncButton")];
  const index = tabs.indexOf(document.activeElement);
  if (index < 0) return;
  const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
    : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
      : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
  if (next < 0) return;
  event.preventDefault();
  tabs[next].click();
  tabs[next].focus();
});
$("exportButton").addEventListener("click", () => {
  closeImportPanel();
  $("backupPanel").hidden = false;
  setTab("backup");
  $("confirmBackup").focus();
});
$("syncButton").addEventListener("click", () => setTab("sync"));
$("syncIndicator").addEventListener("click", () => setTab("sync"));
$("syncConnectLocal").addEventListener("click", async () => {
  $("syncConnectLocal").disabled = true;
  try {
    const result = await send({ type: "connectLocal" });
    if (showActionError(result)) return;
    if (result.needsMerge) {
      mergeEndpoint = { url: result.url };
      mergePreviewRevision = null;
      $("syncMergePanel").hidden = false;
      $("syncMergeReview").hidden = true;
      $("syncServerPassword").focus();
      showNotice("本机和服务器各有账号，请先核对并合并");
      return;
    }
    showNotice("已连接本机服务，账号已同步");
    await renderSyncState();
  } finally { $("syncConnectLocal").disabled = false; }
});
$("syncSetupForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = await send({ type: "configureSync", url: $("syncUrl").value, token: $("syncToken").value });
  if (showActionError(result)) return;
  if (result.needsMerge) {
    mergeEndpoint = { url: $("syncUrl").value, token: $("syncToken").value };
    mergePreviewRevision = null;
    $("syncMergePanel").hidden = false;
    $("syncMergeReview").hidden = true;
    $("syncServerPassword").focus();
    showNotice("本机和服务器各有账号，请先核对并合并");
    return;
  }
  $("syncSetupForm").reset();
  showNotice("已连接服务器，加密保险库已同步");
  await renderSyncState();
});
$("syncPreviewMerge").addEventListener("click", async () => {
  $("syncPreviewMerge").disabled = true;
  try {
    const result = await send({ type: "previewServerMerge", ...mergeEndpoint,
      password: $("syncServerPassword").value });
    if (showActionError(result)) return;
    mergePreviewRevision = result.revision;
    $("syncMergeSummary").textContent =
      `本机 ${result.local} 个，服务器 ${result.server} 个；新增 ${result.added}、更新相同账号 ${result.updated}、相同 ${result.same}。`;
    $("syncMergeReview").hidden = false;
    showNotice("请核对数量，合并后此浏览器改用服务器主密码");
  } finally { $("syncPreviewMerge").disabled = false; }
});
$("syncApplyMerge").addEventListener("click", async () => {
  if (mergePreviewRevision === null) return;
  $("syncApplyMerge").disabled = true;
  try {
    const result = await send({ type: "applyServerMerge", ...mergeEndpoint,
      password: $("syncServerPassword").value, expectedRevision: mergePreviewRevision });
    if (showActionError(result)) return;
    $("syncServerPassword").value = "";
    $("syncMergePanel").hidden = true;
    $("syncMergeReview").hidden = true;
    mergePreviewRevision = null;
    showNotice(`已合并：新增 ${result.added}、更新 ${result.updated}。此浏览器现在使用服务器主密码`);
    await refresh();
  } finally { $("syncApplyMerge").disabled = false; }
});
$("syncReplaceAfterRecovery").addEventListener("click", async () => {
  if (!$("syncUrl").value || !$("syncToken").value) {
    return showNotice("先填写服务器地址和访问令牌", "error");
  }
  if (!confirm("这会用当前本机账号替换服务器上的账号。服务器会保留旧版本，但旧版本中尚未恢复的账号不会进入新库。确认已分别备份本机和服务器数据后再继续。")) return;
  const result = await send({ type: "replaceRemoteAfterRecovery", url: $("syncUrl").value,
    token: $("syncToken").value });
  if (showActionError(result)) return;
  $("syncSetupForm").reset();
  showNotice("服务器副本已重建，其他设备需重新加入");
  await renderSyncState();
});
$("syncNow").addEventListener("click", () => runSync());
$("syncResolve").addEventListener("click", () => {
  const decisions = {};
  for (const row of $("syncConflictList").children) decisions[row.dataset.id] = row.querySelector("select").value;
  runSync(decisions);
});
$("syncDisconnect").addEventListener("click", async () => {
  if (!confirm("断开后不会删除本机保险库，但两端改动将不再同步。继续吗？")) return;
  const result = await send({ type: "disconnectSync" });
  if (showActionError(result)) return;
  renderSyncConflicts([]);
  showNotice("已断开此设备，本机账号仍保留");
  await renderSyncState();
});
$("cancelBackup").addEventListener("click", () => {
  closeBackupPanel();
  setTab("accounts");
});
$("confirmBackup").addEventListener("click", async () => {
  const result = await send({ type: "exportRecovery" });
  if (showActionError(result)) return;
  if (!result.record?.ciphertext || !result.privateKey?.pkcs8) return showNotice("备份生成失败，请重试", "error");
  pendingRecoveryRecord = result.record;
  pendingRecoveryPrivateKey = result.privateKey;
  $("recoveryKeyPanel").hidden = false;
  $("confirmBackup").hidden = true;
  $("downloadPrivateKey").focus();
});
$("downloadPrivateKey").addEventListener("click", () => {
  if (!pendingRecoveryPrivateKey) return;
  downloadJson(pendingRecoveryPrivateKey, `password-vault-private-key-${new Date().toISOString().slice(0, 10)}.json`);
  $("savedPrivateKey").disabled = false;
  showNotice("私钥下载已开始，请确认保存到备份文件之外");
});
$("savedPrivateKey").addEventListener("change", () => {
  $("downloadRecovery").disabled = !$("savedPrivateKey").checked;
});
$("downloadRecovery").addEventListener("click", () => {
  if (!pendingRecoveryRecord || !$("savedPrivateKey").checked) return;
  downloadJson(pendingRecoveryRecord, `password-vault-recovery-${new Date().toISOString().slice(0, 10)}.json`);
  showNotice("恢复文件已开始下载，请确认文件和私钥分别保存");
});
$("exportServerVault").addEventListener("click", async () => {
  const result = await send({ type: "exportVault" });
  if (showActionError(result)) return;
  if (!result.record?.ciphertext) return showNotice("导出失败，请重试", "error");
  const blob = new Blob([JSON.stringify(result.record, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `password-vault-for-server-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showNotice("加密密码文件已下载，请到服务器网页导入；打开文件仍需当前主密码");
});

$("importButton").addEventListener("click", () => {
  closeBackupPanel();
  resetImportPreview();
  $("importPanel").hidden = false;
  setTab("import");
});
$("openBrowserPasswords").addEventListener("click", async () => {
  const browser = browserPasswordSettings();
  try {
    await extensionApi.storage.session.set({ importFlow: true });
    await extensionApi.tabs.create({ url: browser.url });
  } catch {
    await extensionApi.storage.session.remove("importFlow");
    showNotice(`无法打开 ${browser.name} 密码设置，请从浏览器设置中导出密码 CSV`, "error");
  }
});
$("openBrowserCleanup").addEventListener("click", async () => {
  const browser = browserPasswordSettings();
  try {
    await extensionApi.tabs.create({ url: browser.cleanupUrl });
  } catch {
    showNotice(`无法打开 ${browser.name} 清理页，请从浏览器设置中管理已保存的密码`, "error");
  }
});
let useLegacyImportPicker = false;
$("selectImportFile").addEventListener("click", async () => {
  if (!window.showOpenFilePicker || useLegacyImportPicker) {
    $("importFile").click();
    return;
  }
  try {
    const [handle] = await window.showOpenFilePicker({
      startIn: "downloads",
      types: [{ description: "密码 CSV", accept: { "text/csv": [".csv"] } }]
    });
    if (handle) await readImportFile(await handle.getFile());
  } catch (error) {
    if (error.name === "AbortError") return;
    useLegacyImportPicker = true;
    showNotice("无法定位下载目录，请再点一次选择 CSV 并手动定位文件", "error");
  }
});
$("importFile").addEventListener("change", async () => {
  const file = $("importFile").files[0];
  try {
    await readImportFile(file);
  } finally {
    $("importFile").value = "";
  }
});
$("cancelImport").addEventListener("click", () => {
  closeImportPanel();
  setTab("accounts");
});
$("skipImport").addEventListener("click", () => applyImport("skip"));
$("replaceImport").addEventListener("click", () => applyImport("replace"));

$("restoreRecoveryForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = $("recoveryFile").files[0];
  if (!file) return showNotice("请选择加密恢复文件", "error");
  if ($("newMasterPassword").value !== $("newMasterConfirm").value) return showNotice("两次输入的新主密码不一致", "error");
  if (!confirm("这会用恢复文件替换本机保险库，并设置新的主密码。继续吗？")) return;
  try {
    const record = JSON.parse(await file.text());
    const privateKeyFile = $("recoveryPrivateKeyFile").files[0];
    if (record.version === 2 && !privateKeyFile) return showNotice("请选择对应的恢复私钥文件", "error");
    const result = await send({
      type: "restoreRecovery",
      record,
      password: $("recoveryPassword").value,
      privateKey: privateKeyFile ? JSON.parse(await privateKeyFile.text()) : null,
      newPassword: $("newMasterPassword").value
    });
    if (result.error) return showNotice(result.error, "error");
    if (currentMode === "setup") await extensionApi.storage.local.set({ guidePending: true });
    $("restoreRecoveryForm").reset();
    showNotice("已恢复保险库，请牢记新的主密码");
    await refresh();
  } catch {
    showNotice("无法读取加密恢复文件", "error");
  }
});

$("resetVaultButton").addEventListener("click", async () => {
  if (!confirm("这会删除本机保险库，且无法撤销。确定继续吗？")) return;
  if (!confirm("请再次确认：你已经没有可用的恢复文件，仍要清空保险库吗？")) return;
  const result = await send({ type: "resetVault" });
  if (result.error) return showNotice(result.error, "error");
  showNotice("保险库已清空，可以重新创建");
  await refresh();
});

$("generateButton").addEventListener("click", async () => {
  const requestedLength = Math.min(64, Math.max(12, Number($("generatorLength").value) || 24));
  $("generatorLength").value = requestedLength;
  const result = await send({ type: "generatePassword", length: requestedLength });
  if (result.password) {
    $("entryPassword").value = result.password;
    setEntryPasswordVisible(true);
  }
});
$("toggleEntryPassword").addEventListener("click", () => {
  setEntryPasswordVisible($("entryPassword").type === "password");
});
document.querySelectorAll('input[name="entryKind"]').forEach((radio) => radio.addEventListener("change", updateEntryKind));

$("entryForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = await send({
    type: "saveEntry",
    entry: {
      id: editingId,
      kind: entryKind(),
      name: $("entryName").value,
      site: $("entrySite").value,
      username: $("entryUsername").value,
      password: $("entryPassword").value,
      subdomains: $("entrySubdomains").checked
    }
  });
  if (showActionError(result)) return;
  resetEntryForm();
  setTab("accounts");
  showNotice("账号已加密保存");
  await refresh();
});

$("cancelEdit").addEventListener("click", () => {
  resetEntryForm();
  setTab("accounts");
});
$("searchInput").addEventListener("input", renderEntries);
$("pendingSave").addEventListener("click", async () => {
  const pending = pendingLogins[0];
  if (!pending) return;
  const result = await send({
    type: "confirmPendingLogin", tabId: pending.tabId,
    token: pending.token, username: $("pendingUsername").value
  });
  if (showActionError(result)) return;
  showNotice(result.updated ? "账号密码已更新" : "登录信息已加密保存");
  await refresh();
});
$("pendingDismiss").addEventListener("click", async () => {
  const pending = pendingLogins[0];
  if (!pending) return;
  await send({ type: "discardPendingLogin", tabId: pending.tabId, token: pending.token });
  await refresh();
});
$("reloadButton").addEventListener("click", () => extensionApi.runtime.reload());
$("guideButton").addEventListener("click", () => $("guideDialog").showModal());
$("guideClose").addEventListener("click", () => $("guideDialog").close());
$("guideSkip").addEventListener("click", closeFirstRunGuide);
$("guideNext").addEventListener("click", async () => {
  if (guideStep === guideSteps.length - 1) return closeFirstRunGuide();
  guideStep++;
  renderFirstRunGuide();
});
$("openBrowserPasswords").textContent = browserPasswordSettings().label;
$("browserImportHint").textContent = browserPasswordSettings().hint;
$("browserCleanupHint").textContent = browserPasswordSettings().cleanupHint;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) setEntryPasswordVisible(false);
  else checkLockState();
});
extensionApi.storage.onChanged?.addListener((changes, area) => {
  if (area === "session" && changes.syncStatus && currentMode === "unlocked") renderSyncState();
});
setInterval(checkLockState, 2000);
setInterval(() => { if (currentMode === "unlocked" && !document.hidden) renderSyncState(); }, 5000);
updateEntryKind();
refresh();
