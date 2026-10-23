(() => {
  const $ = (id) => document.getElementById(id);
  let state = null;
  let selectedId = null;
  let originalForm = "";
  let busy = false;
  let lastActivity = Date.now();
  let clientRecord = null;
  let selectedSnapshot = null;
  let oldestHistoryRevision = null;
  let pendingImport = null;
  let sharedSessionId = null;
  let sharedTouchAt = 0;
  const bridgePending = new Map();
  const localPage = ["127.0.0.1", "localhost"].includes(location.hostname) && location.protocol === "http:" &&
    Number(location.port) > 0 && Number(location.port) < 65535;
  $("tokenLabel").hidden = localPage;
  $("token").required = !localPage;
  $("tokenHelp").hidden = localPage;

  function bridgeRequest(type, payload = {}) {
    if (!localPage) return Promise.resolve({ available: false });
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        bridgePending.delete(id);
        resolve({ available: false });
      }, 900);
      bridgePending.set(id, { resolve, timer });
      window.postMessage({ channel: "password-vault-local-page-request", id, type, ...payload }, location.origin);
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.channel !== "password-vault-local-page-response") return;
    if (data.type === "changed") {
      if (sharedSessionId && state && !busy) refresh(true);
      return;
    }
    if (!data.id) return;
    const pending = bridgePending.get(data.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    bridgePending.delete(data.id);
    pending.resolve(data.response || { available: false });
  });

  async function localToken() {
    let response;
    try {
      response = await fetch(`http://127.0.0.1:${Number(location.port) + 1}/v1/local-pair`, {
        method: "POST", cache: "no-store", credentials: "omit", redirect: "error"
      });
    } catch { throw new Error("本机服务未连接，请确认服务已启动"); }
    if (!response.ok) throw new Error("无法连接本机服务，请检查服务状态");
    const pair = await response.json();
    if (pair.url !== `http://127.0.0.1:${location.port}` || !/^[0-9a-f]{64}$/.test(pair.token)) {
      throw new Error("本机服务配对信息无效");
    }
    return pair.token;
  }
  $("importClientButton").addEventListener("click", () => $("clientVaultFile").click());
  $("clientVaultFile").addEventListener("change", async () => {
    const file = $("clientVaultFile").files[0];
    if (!file) return;
    try {
      const record = JSON.parse(await file.text());
      if (record?.version !== 1 || record?.kdf !== "PBKDF2-SHA-256" || typeof record.ciphertext !== "string") {
        throw new Error("密码文件格式无效，请选择密码匣导出的加密 JSON");
      }
      clientRecord = record;
      $("importClientButton").textContent = "已选择密码文件";
      $("clientPasswordLabel").hidden = false;
      notice(localPage ? "已选择密码文件。输入主密码后，先核对要导入的账号" :
        "已选择密码文件。输入令牌和主密码后，先核对要导入的账号");
    } catch (error) { clientRecord = null; notice(error.message || "无法读取密码文件", true); }
  });

  function notice(message, error = false) {
    $("notice").textContent = PasswordI18n.t(message);
    $("notice").dataset.tone = error ? "error" : "info";
    $("notice").hidden = !message;
  }

  function lock({ propagate = false } = {}) {
    if (propagate && sharedSessionId) {
      bridgeRequest("sharedLock");
    }
    sharedSessionId = null;
    state = null;
    selectedId = null;
    selectedSnapshot = null;
    originalForm = "";
    $("vaultView").hidden = true;
    $("vaultView").classList.remove("editor-open");
    $("loginView").hidden = false;
    $("lockButton").hidden = true;
    $("token").value = "";
    $("tokenLabel").hidden = localPage;
    $("token").required = !localPage;
    clientRecord = null;
    pendingImport = null;
    $("clientVaultFile").value = "";
    $("importClientButton").textContent = "导入密码文件";
    $("clientPassword").value = "";
    $("clientPasswordLabel").hidden = true;
    $("importReview").hidden = true;
    $("loginForm").hidden = false;
    $("tokenHelp").hidden = localPage;
    $("loginView").classList.remove("review-open");
    $("loginTitle").textContent = "打开保险库";
    $("masterPassword").value = "";
    $("masterConfirm").value = "";
    $("confirmLabel").hidden = true;
    $("loginButton").textContent = "解锁";
    $("entryForm").reset();
    $("entryForm").hidden = true;
    $("emptyDetail").hidden = false;
    $("entryPassword").type = "password";
    $("entries").replaceChildren();
    $("restoreForm").reset();
    $("historyDetail").hidden = true;
    $("issuedToken").value = "";
    $("issuedDevice").hidden = true;
    $("devicesTab").hidden = true;
    showView("accounts");
    notice("");
  }

  function validResource(resource) {
    return ["/v1/vault", "/v1/snapshots", "/v1/devices", "/v1/admin/rotate-token"].includes(resource) ||
      /^\/v1\/snapshots(?:\?before=[1-9]\d*|\/[1-9]\d*)$/.test(resource) ||
      /^\/v1\/devices\/[0-9a-f]{24}$/.test(resource);
  }

  async function request(token, method = "GET", body, resource = "/v1/vault") {
    if (!validResource(resource)) throw new Error("请求地址无效");
    const response = await fetch(resource, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store"
    });
    if (response.status === 401) throw new Error("访问令牌不正确");
    if (response.status === 403) throw new Error("需要管理员令牌");
    if (response.status === 409) return { conflict: true };
    if (!response.ok) throw new Error(`服务器返回 ${response.status}`);
    return response.json();
  }

  function validVault(value) {
    if (value?.version !== 1 || !Array.isArray(value.entries) ||
        value.entries.some((entry) => !entry || typeof entry.id !== "string" ||
          typeof entry.site !== "string" || typeof entry.username !== "string" ||
          typeof entry.password !== "string" ||
          (entry.kind !== undefined && entry.kind !== "site" && entry.kind !== "app"))) {
      throw new Error("保险库内容格式无效");
    }
    return value;
  }

  async function activateSharedAccess(access) {
    if (!access?.available || !access.unlocked || !access.key || !access.token) return false;
    const remote = await request(access.token);
    if (!remote.record || remote.record.salt !== access.salt) {
      throw new Error("本机扩展与服务端不是同一份保险库");
    }
    const key = await PasswordCrypto.importKey(access.key);
    const vault = validVault(await PasswordCrypto.decryptWithKey(key, remote.record));
    await activateVault(access.token, { key, value: vault }, remote.record, remote.revision);
    sharedSessionId = access.sessionId;
    return true;
  }

  async function tryOpenSharedSession() {
    if (!localPage || state || clientRecord || busy) return false;
    const status = await bridgeRequest("sharedState");
    if (!status.available || !status.unlocked) return false;
    const access = await bridgeRequest("sharedAccess");
    try { return await activateSharedAccess(access); }
    catch (error) { notice(error.message || "无法打开已解锁的本机保险库", true); return false; }
  }

  async function activateVault(token, opened, record, revision) {
    const vault = validVault(opened.value);
    state = { token, key: opened.key, record, revision,
      vault, baseVault: structuredClone(vault) };
    $("masterPassword").value = "";
    $("masterConfirm").value = "";
    $("clientPassword").value = "";
    $("token").value = "";
    clientRecord = null;
    pendingImport = null;
    $("clientVaultFile").value = "";
    $("importClientButton").textContent = "导入密码文件";
    $("clientPasswordLabel").hidden = true;
    $("importReview").hidden = true;
    $("loginForm").hidden = false;
    $("loginView").classList.remove("review-open");
    $("loginTitle").textContent = "打开保险库";
    $("confirmLabel").hidden = true;
    $("loginButton").textContent = "解锁";
    $("loginView").hidden = true;
    $("vaultView").hidden = false;
    $("lockButton").hidden = false;
    lastActivity = Date.now();
    selectedId = null;
    selectedSnapshot = null;
    showView("accounts");
    render();
    try {
      await request(token, "GET", undefined, "/v1/devices");
      $("devicesTab").hidden = false;
    } catch {
      $("devicesTab").hidden = true;
    }
    notice("");
  }

  function showImportPreview(plan, serverCount, clientCount) {
    $("importSummary").textContent =
      `导入文件 ${clientCount} 个账号，服务器原有 ${serverCount} 个；新增 ${plan.added}、更新 ${plan.updated}、相同 ${plan.same}。`;
    $("importList").replaceChildren();
    for (const change of plan.changes.slice(0, 80)) {
      const row = document.createElement("div");
      row.className = "import-row";
      const label = document.createElement("span");
      label.textContent = `${change.site} · ${change.username}`;
      const status = document.createElement("strong");
      status.textContent = { added: "新增", updated: "更新", same: "相同" }[change.status];
      row.append(label, status);
      $("importList").append(row);
    }
    $("importReview").hidden = false;
    $("loginForm").hidden = true;
    $("tokenHelp").hidden = true;
    $("loginView").classList.add("review-open");
    $("loginTitle").textContent = "导入密码文件";
    notice("");
  }

  async function openVault(event) {
    event.preventDefault();
    if (busy) return;
    if (!crypto.subtle) return notice("请通过本机地址或 HTTPS 打开保险库", true);
    const password = $("masterPassword").value;
    busy = true;
    $("loginButton").disabled = true;
    try {
      if (localPage && !clientRecord) {
        const shared = await bridgeRequest("sharedState");
        if (shared.available) {
          if (shared.unlocked) {
            const access = await bridgeRequest("sharedAccess");
            if (await activateSharedAccess(access)) return;
          }
          const unlocked = await bridgeRequest("sharedUnlock", { password });
          if (unlocked.error) throw new Error(unlocked.error);
          if (await activateSharedAccess(unlocked)) return;
        }
      }
      let token = $("token").value.trim();
      if (localPage && $("tokenLabel").hidden) {
        try { token = await localToken(); }
        catch (error) {
          $("tokenLabel").hidden = false;
          $("token").required = true;
          throw new Error(`${error.message}；也可手动输入访问令牌重试`);
        }
      }
      if (!/^[0-9a-f]{64}$/.test(token)) throw new Error("访问令牌格式无效");
      const remote = await request(token);
      let record = remote.record;
      let revision = remote.revision;
      let opened;
      if (!record) {
        if (clientRecord) {
          const clientPassword = $("clientPassword").value || password;
          if (clientPassword !== password && password.length < 12) {
            throw new Error("新的服务器主密码至少需要 12 位");
          }
          let imported;
          try { imported = await PasswordCrypto.openRecord(clientPassword, clientRecord); }
          catch { throw new Error("导入文件的主密码不正确，或文件已损坏"); }
          validVault(imported.value);
          record = await PasswordCrypto.createRecord(password, imported.value);
          const saved = await request(token, "PUT", { expectedRevision: 0, record });
          if (saved.conflict) throw new Error("服务器已有保险库，请重新打开并直接解锁");
          revision = saved.revision;
        } else {
        if ($("confirmLabel").hidden) {
          $("confirmLabel").hidden = false;
          $("loginButton").textContent = "创建新保险库";
          notice("服务器还没有保险库。若已有浏览器账号，请先在扩展的“同步”页连接服务器；仅首次使用时在这里创建新库");
          return;
        }
        if (password.length < 12 || password !== $("masterConfirm").value) {
          throw new Error("主密码至少 12 位，且两次输入需一致");
        }
        record = await PasswordCrypto.createRecord(password, { version: 1, entries: [] });
        const saved = await request(token, "PUT", { expectedRevision: 0, record });
        if (saved.conflict) throw new Error("其他设备已经创建保险库，请重新打开");
        revision = saved.revision;
        }
      } else if (clientRecord) {
        let serverOpened;
        let imported;
        try { serverOpened = await PasswordCrypto.openRecord(password, record); }
        catch { throw new Error("服务器主密码不正确，或账号数据已损坏"); }
        try { imported = await PasswordCrypto.openRecord($("clientPassword").value || password, clientRecord); }
        catch { throw new Error("导入文件的主密码不正确，或文件已损坏"); }
        const serverVault = validVault(serverOpened.value);
        const importedVault = validVault(imported.value);
        const plan = VaultSync.combine(importedVault, serverVault);
        pendingImport = { token, revision, record, serverVault, importedVault };
        showImportPreview(plan, serverVault.entries.length, importedVault.entries.length);
        return;
      }
      try { opened = await PasswordCrypto.openRecord(password, record); }
      catch { throw new Error("主密码不正确，或保险库数据已损坏"); }
      await activateVault(token, opened, record, revision);
    } catch (error) {
      notice(error.message || "无法打开保险库", true);
    } finally {
      busy = false;
      $("loginButton").disabled = false;
    }
  }

  async function confirmImport() {
    if (!pendingImport || !clientRecord || busy) return;
    const mode = document.querySelector('input[name="importMode"]:checked')?.value || "merge";
    if (mode === "replace" && !window.confirm(
      "用导入文件覆盖服务器上的全部账号？服务器独有账号会从当前版本移除，旧数据仍保留在历史版本；其他设备需重新加入。")) return;
    busy = true;
    $("confirmImport").disabled = true;
    try {
      const { token, revision } = pendingImport;
      const current = await request(token);
      if (current.revision !== revision || !VaultSync.same(current.record, pendingImport.record)) {
        throw new Error("服务器账号已变化，请返回重新核对导入内容");
      }
      const password = $("masterPassword").value;
      let serverOpened;
      let imported;
      try { serverOpened = await PasswordCrypto.openRecord(password, current.record); }
      catch { throw new Error("服务器主密码不正确"); }
      try { imported = await PasswordCrypto.openRecord($("clientPassword").value || password, clientRecord); }
      catch { throw new Error("导入文件的主密码不正确"); }
      const serverVault = validVault(serverOpened.value);
      const importedVault = validVault(imported.value);
      const plan = VaultSync.combine(importedVault, serverVault);
      let record = current.record;
      let savedRevision = current.revision;
      if (mode === "replace") {
        if (password.length < 12) throw new Error("服务器主密码至少需要 12 位");
        record = await PasswordCrypto.createRecord(password, importedVault);
      } else if (plan.added || plan.updated) {
        record = { ...record, ...await PasswordCrypto.encryptWithKey(serverOpened.key, plan.vault) };
      }
      if (record !== current.record) {
        const saved = await request(token, "PUT", { expectedRevision: current.revision, record });
        if (saved.conflict) throw new Error("服务器账号已变化，请返回重新核对");
        savedRevision = saved.revision;
      }
      const opened = await PasswordCrypto.openRecord(password, record);
      await activateVault(token, opened, record, savedRevision);
      notice(mode === "replace" ? "服务器账号已替换；其他设备需重新加入" :
        `已合并：新增 ${plan.added}、更新 ${plan.updated}、相同 ${plan.same}`);
    } catch (error) { notice(error.message || "导入失败", true); }
    finally { busy = false; $("confirmImport").disabled = false; }
  }

  async function cancelImport() {
    if (busy) return;
    clientRecord = null;
    pendingImport = null;
    $("clientVaultFile").value = "";
    $("importClientButton").textContent = "导入密码文件";
    $("clientPassword").value = "";
    $("clientPasswordLabel").hidden = true;
    $("importReview").hidden = true;
    $("loginForm").hidden = false;
    $("tokenHelp").hidden = localPage;
    $("loginView").classList.remove("review-open");
    $("loginTitle").textContent = "打开保险库";
    await openVault({ preventDefault() {} });
  }

  function formValue() {
    return JSON.stringify([$("entryName").value, $("entrySite").value, $("entryUsername").value,
      $("entryPassword").value, $("subdomains").checked,
      document.querySelector('input[name="entryKind"]:checked')?.value || "site"]);
  }

  function entryKind() {
    return document.querySelector('input[name="entryKind"]:checked')?.value === "app" ? "app" : "site";
  }

  function updateEntryKind() {
    const app = entryKind() === "app";
    $("entrySiteLabel").textContent = app ? "App 名称" : "网站域名";
    $("entrySite").placeholder = app ? "例如：微信、企业微信" : "example.com";
    $("entrySite").inputMode = app ? "text" : "url";
    $("subdomains").closest("label").hidden = app;
  }

  function confirmDiscard() {
    return $("entryForm").hidden || originalForm === formValue() ||
      window.confirm("当前修改尚未保存。放弃修改吗？");
  }

  function selectEntry(id, force = false) {
    if (!force && !confirmDiscard()) return;
    selectedId = id;
    const entry = state.vault.entries.find((item) => item.id === id);
    $("entryForm").hidden = false;
    $("emptyDetail").hidden = true;
    $("detailTitle").textContent = entry ? "编辑账号" : "添加账号";
    $("deleteButton").hidden = !entry;
    const siteUrl = entry?.kind === "app" ? "" : PasswordCrypto.siteUrl(entry?.site);
    $("visitSiteButton").hidden = !siteUrl;
    $("visitSiteButton").dataset.url = siteUrl;
    const kind = entry?.kind === "app" ? "app" : "site";
    document.querySelectorAll('input[name="entryKind"]').forEach((radio) => { radio.checked = radio.value === kind; });
    $("entryName").value = entry?.name || "";
    $("entrySite").value = entry?.site || "";
    $("entryUsername").value = entry?.username || "";
    $("entryPassword").value = entry?.password || "";
    $("entryPasswordScope").hidden = !entry;
    $("entryPassword").type = "password";
    $("showPassword").title = "显示密码";
    $("showPassword").setAttribute("aria-label", "显示密码");
    $("subdomains").checked = Boolean(entry?.subdomains);
    updateEntryKind();
    originalForm = formValue();
    $("vaultView").classList.add("editor-open");
    renderList();
  }

  function renderList() {
    if (!state) return;
    const query = $("search").value.trim().toLocaleLowerCase();
    const entries = [...state.vault.entries].sort((a, b) => (a.kind || "site").localeCompare(b.kind || "site") || a.site.localeCompare(b.site) ||
      a.username.localeCompare(b.username));
    const filtered = entries.filter((entry) => [entry.name, entry.site, entry.username]
      .some((field) => String(field || "").toLocaleLowerCase().includes(query)));
    $("entryCount").textContent = `${state.vault.entries.length} 个账号`;
    const items = filtered.map((entry) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "entry-button";
      button.setAttribute("aria-current", String(entry.id === selectedId));
      const title = document.createElement("strong");
      title.textContent = entry.name || entry.site;
      const subtitle = document.createElement("span");
      subtitle.textContent = `${entry.kind === "app" ? "App" : entry.site} · ${entry.username}`;
      const mark = document.createElement("span");
      mark.className = "entry-mark";
      mark.dataset.kind = entry.kind === "app" ? "app" : "site";
      mark.setAttribute("aria-hidden", "true");
      mark.textContent = (entry.name || entry.site).trim().slice(0, 1).toLocaleUpperCase();
      const copy = document.createElement("span");
      copy.className = "entry-copy";
      copy.append(title, subtitle);
      button.append(mark, copy);
      button.addEventListener("click", () => selectEntry(entry.id));
      return button;
    });
    $("entries").replaceChildren(...items);
    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = query ? "没有匹配的账号" : "还没有账号";
      $("entries").append(empty);
    }
  }

  function render() {
    renderList();
    if (selectedId && !state.vault.entries.some((entry) => entry.id === selectedId)) {
      selectedId = null;
      $("entryForm").hidden = true;
      $("emptyDetail").hidden = false;
      $("vaultView").classList.remove("editor-open");
    }
  }

  function showView(view) {
    for (const name of ["accounts", "history", "devices"]) {
      $(`${name}View`).hidden = name !== view;
      if (name === view) $(`${name}Tab`).setAttribute("aria-current", "page");
      else $(`${name}Tab`).removeAttribute("aria-current");
    }
    $("issuedToken").value = "";
    $("issuedDevice").hidden = true;
  }

  async function loadHistory() {
    $("historyList").replaceChildren();
    $("historyDetail").hidden = true;
    selectedSnapshot = null;
    oldestHistoryRevision = null;
    $("loadMoreHistory").hidden = true;
    await appendHistory();
  }

  async function appendHistory() {
    const resource = oldestHistoryRevision
      ? `/v1/snapshots?before=${oldestHistoryRevision}` : "/v1/snapshots";
    const { snapshots, hasMore } = await request(state.token, "GET", undefined, resource);
    $("clearHistory").hidden = $("devicesTab").hidden || (!oldestHistoryRevision && !snapshots.length);
    $("loadMoreHistory").hidden = !hasMore;
    if (!snapshots.length) {
      if (!oldestHistoryRevision) $("historyList").textContent = PasswordI18n.t("还没有历史版本");
      return;
    }
    oldestHistoryRevision = snapshots.at(-1).revision;
    for (const snapshot of snapshots) {
      const row = document.createElement("div");
      row.className = "management-row";
      const label = document.createElement("span");
      label.textContent = `版本 ${snapshot.revision} · ${new Date(snapshot.createdAt).toLocaleString()}`;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "plain-button";
      button.textContent = "查看";
      button.addEventListener("click", () => openSnapshot(snapshot.revision));
      row.append(label, button);
      $("historyList").append(row);
    }
  }

  async function openSnapshot(revision) {
    try {
      const snapshot = await request(state.token, "GET", undefined, `/v1/snapshots/${revision}`);
      selectedSnapshot = snapshot;
      $("historyTitle").textContent = `版本 ${revision}`;
      $("historyDetail").hidden = false;
      $("deleteSnapshot").hidden = $("devicesTab").hidden;
      $("restoreForm").reset();
      $("restoreForm").hidden = true;
      if (snapshot.record.salt !== state.record.salt) {
        $("historySummary").textContent = "此版本使用另一组主密码。可下载文件，用当时的主密码打开；不能在当前会话直接恢复。";
        return;
      }
      const vault = validVault(await PasswordCrypto.decryptWithKey(state.key, snapshot.record));
      $("historySummary").textContent = `${vault.entries.length} 个账号`;
      $("restoreForm").hidden = false;
      notice("");
    } catch (error) { notice(error.message || "无法打开历史版本", true); }
  }

  async function deleteSnapshot() {
    if (!selectedSnapshot || busy) return;
    const revision = selectedSnapshot.revision;
    if (!confirm(PasswordI18n.t(`删除历史版本 ${revision}？删除后无法恢复或下载此版本，当前账号不受影响。`))) return;
    busy = true;
    try {
      const result = await request(state.token, "DELETE", undefined, `/v1/snapshots/${revision}`);
      if (result.conflict) throw new Error("当前版本不能删除");
      await loadHistory();
      notice("历史版本已删除");
    } catch (error) { notice(error.message || "删除历史版本失败", true); }
    finally { busy = false; }
  }

  async function clearHistory() {
    if (busy || !confirm(PasswordI18n.t("删除服务器上所有历史版本？当前保险库不受影响，此操作无法撤销。"))) return;
    busy = true;
    try {
      await request(state.token, "DELETE", undefined, "/v1/snapshots");
      await loadHistory();
      notice("历史版本已清空");
    } catch (error) { notice(error.message || "清空历史失败", true); }
    finally { busy = false; }
  }

  async function restoreSnapshot(event) {
    event.preventDefault();
    if (!state || !selectedSnapshot || busy) return;
    busy = true;
    $("restoreButton").disabled = true;
    try {
      const current = await request(state.token);
      if (current.revision !== state.revision || current.record?.salt !== state.record.salt) {
        throw new Error("服务器已有新更改，请先同步并重新选择历史版本");
      }
      const password = $("restorePassword").value;
      let opened;
      try { opened = await PasswordCrypto.openRecord(password, current.record); }
      catch { throw new Error("当前主密码不正确"); }
      if (selectedSnapshot.record.salt !== current.record.salt) throw new Error("历史版本使用另一组主密码");
      const vault = validVault(await PasswordCrypto.decryptWithKey(opened.key, selectedSnapshot.record));
      const record = await PasswordCrypto.createRecord(password, vault);
      const saved = await request(state.token, "PUT", { expectedRevision: current.revision, record });
      if (saved.conflict) throw new Error("服务器已有新更改，请先同步再恢复");
      const restored = await PasswordCrypto.openRecord(password, record);
      state = { ...state, key: restored.key, record, revision: saved.revision,
        vault, baseVault: structuredClone(vault) };
      selectedId = null;
      selectedSnapshot = null;
      $("entryForm").hidden = true;
      $("emptyDetail").hidden = false;
      $("vaultView").classList.remove("editor-open");
      showView("accounts");
      render();
      await publishSharedRecord();
      notice("历史版本已恢复；其他设备需重新加入");
    } catch (error) { notice(error.message || "恢复失败", true); }
    finally {
      $("restoreForm").reset();
      $("restoreButton").disabled = false;
      busy = false;
    }
  }

  async function loadDevices() {
    const { devices } = await request(state.token, "GET", undefined, "/v1/devices");
    $("deviceList").replaceChildren();
    if (!devices.length) {
      $("deviceList").textContent = "还没有单独授权的设备";
      return;
    }
    for (const device of devices) {
      const row = document.createElement("div");
      row.className = "management-row";
      const label = document.createElement("span");
      label.textContent = `${device.name} · ${new Date(device.createdAt).toLocaleString()}`;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "danger-button";
      button.textContent = "撤销";
      button.addEventListener("click", async () => {
        if (!window.confirm(`撤销“${device.name}”的访问？该设备将无法继续同步。`)) return;
        try {
          await request(state.token, "DELETE", undefined, `/v1/devices/${device.id}`);
          await loadDevices();
          notice("设备访问已撤销");
        } catch (error) { notice(error.message || "撤销失败", true); }
      });
      row.append(label, button);
      $("deviceList").append(row);
    }
  }

  async function createDevice(event) {
    event.preventDefault();
    if (!state || busy) return;
    busy = true;
    $("createDevice").disabled = true;
    try {
      const name = $("deviceName").value.trim();
      const result = await request(state.token, "POST", { name }, "/v1/devices");
      $("deviceName").value = "";
      $("issuedToken").value = result.token;
      $("issuedDevice").hidden = false;
      await loadDevices();
      notice("设备令牌已生成，复制后在另一设备连接服务器");
    } catch (error) { notice(error.message || "生成设备令牌失败", true); }
    finally { busy = false; $("createDevice").disabled = false; }
  }

  async function rotateAdminToken() {
    if (!state || busy || !window.confirm("更换管理员令牌？使用旧令牌的远程设备需改用单独设备令牌；本机扩展会重新配对。")) return;
    busy = true;
    $("rotateAdminToken").disabled = true;
    try {
      const result = await request(state.token, "POST", undefined, "/v1/admin/rotate-token");
      state.token = result.token;
      notice("管理员令牌已更换；本机扩展下次同步时会重新配对");
    } catch (error) { notice(error.message || "更换令牌失败", true); }
    finally { busy = false; $("rotateAdminToken").disabled = false; }
  }

  async function mergeRemote(localVault, remote) {
    if (!remote.record || remote.record.salt !== state.record.salt) {
      throw new Error("服务器保险库已更换密钥。请先锁定并核对恢复备份");
    }
    const remoteVault = validVault(await PasswordCrypto.decryptWithKey(state.key, remote.record));
    let result = VaultSync.merge(state.baseVault, localVault, remoteVault);
    if (result.conflicts.length) {
      const decisions = {};
      for (const conflict of result.conflicts) {
        const entry = conflict.local || conflict.remote;
        decisions[conflict.id] = window.confirm(
          `${entry?.site || "账号"} / ${entry?.username || ""} 在另一台设备也已更改。\n确定：保留本次修改；取消：保留服务器版本。`
        ) ? "local" : "remote";
      }
      result = VaultSync.merge(state.baseVault, localVault, remoteVault, decisions);
    }
    state.revision = remote.revision;
    state.record = remote.record;
    state.baseVault = structuredClone(remoteVault);
    return result.vault;
  }

  async function publishSharedRecord() {
    if (!sharedSessionId || !state) return;
    const result = await bridgeRequest("sharedCommit", { record: state.record, revision: state.revision });
    if (result.deferred) notice("扩展还有未同步修改，等待同步合并", true);
  }

  async function commit(nextVault) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const encrypted = await PasswordCrypto.encryptWithKey(state.key, nextVault);
      const record = { ...state.record, ...encrypted };
      const saved = await request(state.token, "PUT", { expectedRevision: state.revision, record });
      if (!saved.conflict) {
        state.revision = saved.revision;
        state.record = record;
        state.vault = nextVault;
        state.baseVault = structuredClone(nextVault);
        await publishSharedRecord();
        return;
      }
      nextVault = await mergeRemote(nextVault, await request(state.token));
    }
    throw new Error("其他设备持续修改保险库，请稍后再试");
  }

  async function saveEntry(event) {
    event.preventDefault();
    if (!state || busy) return;
    const kind = entryKind();
    const rawSite = $("entrySite").value.trim();
    const site = kind === "app" ? rawSite.toLowerCase().slice(0, 253) : PasswordCrypto.normalizeHost(rawSite);
    const username = $("entryUsername").value.trim();
    const password = $("entryPassword").value;
    if ((kind === "site" && !/^[a-z0-9.-]+$/.test(site)) || !site || !username || !password) {
      return notice(kind === "app" ? "请填写 App 名称、账号和密码" : "请填写有效网站域名、用户名和密码", true);
    }
    const duplicate = state.vault.entries.find((entry) => entry.id !== selectedId &&
      (entry.kind || "site") === kind && entry.site === site && entry.username === username);
    if (duplicate) return notice(kind === "app" ? "这个 App 和账号已经存在，请编辑原记录" : "这个网站和用户名已经存在，请编辑原账号", true);
    const original = state.vault.entries.find((entry) => entry.id === selectedId);
    if (original && original.password !== password &&
      !window.confirm(PasswordI18n.t("请确认新密码已在网站或 App 生效。这里只更新密码匣记录，继续吗？"))) return;
    const id = selectedId || crypto.randomUUID();
    const entry = { id, kind, name: $("entryName").value.trim().slice(0, 100), site,
      username: username.slice(0, 320), password: password.slice(0, 1000),
      subdomains: $("subdomains").checked, updatedAt: new Date().toISOString() };
    const nextVault = structuredClone(state.vault);
    const index = nextVault.entries.findIndex((item) => item.id === id);
    if (index >= 0) nextVault.entries[index] = entry;
    else nextVault.entries.push(entry);
    busy = true;
    $("saveButton").disabled = true;
    try {
      await commit(nextVault);
      selectedId = id;
      selectEntry(id, true);
      render();
      notice("已保存并同步");
    } catch (error) { notice(error.message || "保存失败", true); }
    finally { busy = false; $("saveButton").disabled = false; }
  }

  async function deleteEntry() {
    if (!state || !selectedId || busy || !window.confirm("删除这个账号？删除会同步到其他设备。")) return;
    const nextVault = structuredClone(state.vault);
    nextVault.entries = nextVault.entries.filter((entry) => entry.id !== selectedId);
    busy = true;
    try {
      await commit(nextVault);
      selectedId = null;
      $("entryForm").hidden = true;
      $("emptyDetail").hidden = false;
      $("vaultView").classList.remove("editor-open");
      render();
      notice("账号已删除");
    } catch (error) { notice(error.message || "删除失败", true); }
    finally { busy = false; }
  }

  async function refresh(automatic = false) {
    if (!state || busy || (automatic
      ? (!$("entryForm").hidden && (!selectedId || originalForm !== formValue()))
      : !confirmDiscard())) return;
    busy = true;
    try {
      const remote = await request(state.token);
      if (remote.revision === state.revision) {
        if (!automatic) notice("已是最新账号");
        return;
      }
      if (!remote.record || remote.record.salt !== state.record.salt) {
        throw new Error("服务器保险库已更换密钥。请先锁定并核对恢复备份");
      }
      const vault = validVault(await PasswordCrypto.decryptWithKey(state.key, remote.record));
      const previousId = selectedId;
      const editorWasOpen = $("vaultView").classList.contains("editor-open");
      state.record = remote.record;
      state.revision = remote.revision;
      state.vault = vault;
      state.baseVault = structuredClone(vault);
      if (previousId && vault.entries.some((entry) => entry.id === previousId)) {
        selectEntry(previousId, true);
        if (!editorWasOpen) $("vaultView").classList.remove("editor-open");
      } else {
        selectedId = null;
        $("entryForm").hidden = true;
        $("emptyDetail").hidden = false;
        $("vaultView").classList.remove("editor-open");
      }
      render();
      await publishSharedRecord();
      notice("已同步最新账号");
    } catch (error) { notice(error.message || "同步失败", true); }
    finally { busy = false; }
  }

  function downloadRecord(record, filename) {
    const blob = new Blob([JSON.stringify(record)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notice("密码文件已下载；打开仍需对应版本的主密码，不能凭它重设主密码");
  }

  function exportEncrypted() {
    if (!state) return;
    downloadRecord(state.record, `password-vault-encrypted-${new Date().toISOString().slice(0, 10)}.json`);
  }

  $("loginForm").addEventListener("submit", openVault);
  $("guideButton").addEventListener("click", () => $("guideDialog").showModal());
  $("guideClose").addEventListener("click", () => $("guideDialog").close());
  $("confirmImport").addEventListener("click", confirmImport);
  $("cancelImport").addEventListener("click", cancelImport);
  $("accountsTab").addEventListener("click", () => showView("accounts"));
  $("historyTab").addEventListener("click", async () => {
    if (!state || !confirmDiscard()) return;
    showView("history");
    try { await loadHistory(); }
    catch (error) { notice(error.message || "读取历史失败", true); }
  });
  $("devicesTab").addEventListener("click", async () => {
    if (!state || !confirmDiscard()) return;
    showView("devices");
    try { await loadDevices(); }
    catch (error) { notice(error.message || "读取设备失败", true); }
  });
  $("downloadCurrent").addEventListener("click", exportEncrypted);
  $("downloadSnapshot").addEventListener("click", () => {
    if (selectedSnapshot) downloadRecord(selectedSnapshot.record,
      `password-vault-revision-${selectedSnapshot.revision}.json`);
  });
  $("loadMoreHistory").addEventListener("click", () => appendHistory().catch((error) => notice(error.message || "读取历史失败", true)));
  $("deleteSnapshot").addEventListener("click", deleteSnapshot);
  $("clearHistory").addEventListener("click", clearHistory);
  $("restoreForm").addEventListener("submit", restoreSnapshot);
  $("deviceForm").addEventListener("submit", createDevice);
  $("rotateAdminToken").addEventListener("click", rotateAdminToken);
  $("copyDeviceToken").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("issuedToken").value);
      notice("设备令牌已复制");
    } catch { notice("复制失败，请手动选择令牌", true); }
  });
  $("entryForm").addEventListener("submit", saveEntry);
  $("lockButton").addEventListener("click", () => lock({ propagate: true }));
  $("refreshButton").addEventListener("click", () => {
    $("toolbarMenu").open = false;
    refresh();
  });
  $("exportButton").addEventListener("click", () => {
    $("toolbarMenu").open = false;
    exportEncrypted();
  });
  $("newButton").addEventListener("click", () => { if (state) selectEntry(null); });
  $("backButton").addEventListener("click", () => { if (confirmDiscard()) $("vaultView").classList.remove("editor-open"); });
  $("deleteButton").addEventListener("click", deleteEntry);
  $("visitSiteButton").addEventListener("click", () => {
    const url = $("visitSiteButton").dataset.url;
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  });
  $("search").addEventListener("input", renderList);
  $("showPassword").addEventListener("click", () => {
    const visible = $("entryPassword").type === "password";
    $("entryPassword").type = visible ? "text" : "password";
    $("showPassword").title = visible ? "隐藏密码" : "显示密码";
    $("showPassword").setAttribute("aria-label", visible ? "隐藏密码" : "显示密码");
  });
  $("generateButton").addEventListener("click", () => {
    $("entryPassword").value = PasswordCrypto.generatePassword();
    $("entryPassword").type = "text";
    $("showPassword").title = "隐藏密码";
    $("showPassword").setAttribute("aria-label", "隐藏密码");
  });
  $("copyButton").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("entryPassword").value);
      notice("已复制密码，请注意剪贴板内容");
    } catch { notice("复制失败，请手动选择密码", true); }
  });
  for (const name of ["pointerdown", "keydown"]) {
    document.addEventListener(name, () => {
      if (!state) return;
      lastActivity = Date.now();
      if (sharedSessionId && Date.now() - sharedTouchAt > 10000) {
        sharedTouchAt = Date.now();
        bridgeRequest("sharedTouch");
      }
    });
  }
  async function checkSharedSession() {
    if (!localPage) return;
    const shared = await bridgeRequest("sharedState");
    if (!shared.available) {
      if (sharedSessionId) lock();
      return;
    }
    if (!shared.unlocked) {
      if (state) lock();
      return;
    }
    if (state && sharedSessionId && sharedSessionId !== shared.sessionId) lock();
    if (!state) await tryOpenSharedSession();
  }
  setInterval(() => {
    if (state && !sharedSessionId && Date.now() - lastActivity > 15 * 60 * 1000) lock();
    checkSharedSession();
  }, localPage ? 2000 : 30 * 1000);
  setInterval(() => { if (state && document.visibilityState === "visible") refresh(true); }, 60 * 1000);
  window.addEventListener("pagehide", () => lock());
  if (localPage) setTimeout(() => { tryOpenSharedSession(); }, 0);
})();
