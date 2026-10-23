(function () {
  const api = globalThis.browser || globalThis.chrome;
  const translations = {
    "密码匣": "Password Vault",
    "我的账号": "My accounts",
    "打开保险库": "Open vault",
    "独立保险库": "Private vault",
    "检查中": "Checking",
    "已锁定": "Locked",
    "已解锁": "Unlocked",
    "未初始化": "Not set up",
    "锁定": "Lock",
    "解锁": "Unlock",
    "关闭": "Close",
    "使用指导": "Guide",
    "首次使用": "First use",
    "下一步": "Next",
    "完成": "Done",
    "跳过": "Skip",
    "添加 / 保存": "Add / save",
    "保存": "Save",
    "保存账号": "Save account",
    "导入": "Import",
    "导入密码文件": "Import password file",
    "导入文件": "Import file",
    "导出密码文件": "Export password file",
    "下载密码文件": "Download password file",
    "下载当前版本": "Download current version",
    "下载此版本": "Download this version",
    "恢复备份": "Restore backup",
    "备份与恢复": "Backup and restore",
    "备份与解锁": "Backup and unlock",
    "同步": "Sync",
    "更多操作": "More actions",
    "立即同步": "Sync now",
    "本机": "This device",
    "仅本机": "This device only",
    "设备": "Devices",
    "设备访问": "Device access",
    "账号": "Accounts",
    "添加": "Add",
    "历史": "History",
    "网站": "Website",
    "App": "App",
    "名称": "Name",
    "网站域名": "Website domain",
    "用户名": "Username",
    "用户名或邮箱": "Username or email",
    "登录账号": "Login account",
    "密码": "Password",
    "主密码": "Master password",
    "原主密码": "Original master password",
    "恢复密码": "Recovery password",
    "恢复私钥文件": "Recovery private key file",
    "旧备份的恢复密码": "Recovery password for an older backup",
    "备份密码": "Backup password",
    "生成恢复备份": "Create recovery backup",
    "下载恢复私钥": "Download recovery private key",
    "下载加密恢复文件": "Download encrypted recovery file",
    "我已单独保存恢复私钥": "I have stored the private key separately",
    "旧版备份使用": "For older backups",
    "输入单独保存的恢复私钥": "Select the separately stored private key",
    "旧版备份或密码文件的密码": "Password for an older backup or vault file",
    "至少 12 个字符": "At least 12 characters",
    "备份文件和恢复私钥分别保存。忘记主密码时，用这两个文件重新设置。": "Keep the backup and recovery private key in separate places. Both are needed to reset a forgotten master password.",
    "浏览器生成恢复公钥和私钥。先单独保存私钥，再下载加密备份；忘记主密码时需要这两个文件。": "The browser generates a recovery key pair. Store the private key separately, then download the encrypted backup. Both files are needed for recovery.",
    "私钥文件只提供这一次。请把它移到备份文件之外；两个文件一起泄露就会暴露账号。": "The private key is available only now. Move it away from the backup; anyone with both files can read your accounts.",
    "新的主密码": "New master password",
    "确认新主密码": "Confirm new master password",
    "确认主密码": "Confirm master password",
    "服务器地址": "Server address",
    "访问令牌": "Access token",
    "服务器访问令牌": "Server access token",
    "服务器版本": "Server version",
    "服务器还没有保险库": "The server has no vault yet",
    "服务器已有保险库": "The server already has a vault",
    "本机与服务器各有保险库": "Both this device and the server have a vault",
    "生成": "Generate",
    "生成密码": "Generate password",
    "复制": "Copy",
    "复制密码": "Copy password",
    "复制账号": "Copy username",
    "打开网站": "Open website",
    "以 HTTPS 打开网站": "Open website with HTTPS",
    "复制令牌": "Copy token",
    "编辑": "Edit",
    "编辑账号": "Edit account",
    "删除": "Delete",
    "取消": "Cancel",
    "取消编辑": "Cancel edit",
    "返回列表": "Back to list",
    "返回账号": "Back to accounts",
    "查看": "View",
    "撤销": "Revoke",
    "新设备名称": "New device name",
    "生成设备令牌": "Generate device token",
    "更换管理员令牌": "Rotate admin token",
    "清空保险库并重新开始": "Clear vault and start over",
    "从浏览器导入": "Import from browser",
    "打开密码导出页": "Open password export page",
    "选择导出的 CSV": "Choose exported CSV",
    "打开浏览器清理页": "Open browser cleanup page",
    "清理浏览器旧密码": "Clear old browser passwords",
    "只添加新账号": "Add new accounts only",
    "导入并覆盖重复项": "Import and replace duplicates",
    "确认导入": "Confirm import",
    "暂不导入": "Cancel import",
    "核对导入内容": "Review import",
    "重复密码": "Reused passwords",
    "检查重复密码": "Check reused passwords",
    "待保存的登录": "Pending login",
    "不保存": "Don't save",
    "用恢复备份找回账号": "Recover accounts from backup",
    "临时使用加密备份": "Use encrypted backup temporarily",
    "本机使用": "Use on this device",
    "临时使用": "Temporary use",
    "选择账号来源": "Choose account source",
    "只读查看，不保存账号更改。": "Read-only access. Account changes are not saved.",
    "使用当前账号": "Use current accounts",
    "直接查看，返回后继续正常使用": "View now, then return to normal use",
    "选择已有的加密密码文件": "Select an existing encrypted vault file",
    "自己的服务器": "Your server",
    "从 HTTPS 服务取回账号": "Get accounts from your HTTPS server",
    "打开密码文件": "Open vault file",
    "连接自己的服务器": "Connect to your server",
    "返回选择来源": "Choose another source",
    "返回日常使用": "Return to normal use",
    "结束临时使用": "End temporary use",
    "返回": "Back",
    "只读查看 · 不会保存或同步更改": "Read-only · Changes are not saved or synced",
    "使用方式": "Usage mode",
    "账号来源": "Account source",
    "密码文件": "Vault file",
    "加密密码文件": "Encrypted vault file",
    "自建服务器": "Self-hosted server",
    "HTTPS 服务地址": "HTTPS server address",
    "设备令牌": "Device token",
    "密码文件的主密码（若不同于当前主密码）": "Vault file master password (if different)",
    "其他设备使用自己的设备令牌。": "Use your own device token on another device.",
    "本机输入主密码；其他设备再输入对应的设备令牌。": "Enter your master password locally; on another device, also enter its device token.",
    "选择从密码匣导出的加密文件。先核对账号，再决定合并或替换。": "Choose an encrypted export from Password Vault. Review accounts before merging or replacing.",
    "读取服务器上的最新账号；保存或删除后会自动同步。": "Get the latest accounts from your server. Saves and deletions sync automatically.",
    "保存加密的账号副本。打开时仍需主密码；忘记主密码请用恢复备份。": "Save an encrypted copy of your accounts. It still needs your master password; use a recovery backup if you forget it.",
    "用于迁移账号或在服务器网页导入。再次打开仍需主密码；忘记主密码时请使用恢复备份。": "Use for moving accounts or importing into the server page. Opening it still needs your master password; use a recovery backup if you forget it.",
    "临时解锁": "Open temporarily",
    "临时取回并解锁": "Fetch and open temporarily",
    "这次取回的账号只在当前会话使用。": "Retrieved accounts are available only for this session.",
    "关闭浏览器会清除会话，所选文件不会被删除。": "Closing the browser clears the session, but does not delete the selected file.",
    "不下载文件；关闭浏览器后会话自动结束。": "No file is downloaded. The session ends when the browser closes.",
    "5 分钟无操作自动锁定。": "Locks after 5 minutes of inactivity.",
    "从入口选择当前账号、密码文件或自己的服务器。临时查看只读，关闭浏览器后自动结束。": "Choose current accounts, a vault file, or your server. Temporary access is read-only and ends when the browser closes.",
    "需要时开启": "Turn on when needed",
    "只读查看；本机账号仍保留": "Read-only; local accounts remain",
    "会话自动清除；文件仍在磁盘": "Session clears; file stays on disk",
    "关闭浏览器自动结束": "Ends when browser closes",
    "从密码文件或服务器打开": "Open a vault file or server",
    "临时会话已清除；下载的密码文件仍在本机": "Session cleared; downloaded vault file remains on this device",
    "加密恢复文件": "Encrypted recovery file",
    "加密备份文件": "Encrypted backup file",
    "备份密码": "Backup password",
    "导出加密恢复备份": "Export encrypted recovery backup",
    "导出到本机": "Export to this device",
    "在服务器网页导入账号": "Import accounts on the server page",
    "从已有服务器加入": "Join an existing server",
    "从本机服务取回": "Get from local service",
    "其他设备或自定义地址": "Other device or custom address",
    "取回并解锁": "Retrieve and unlock",
    "创建密码匣": "Create password vault",
    "创建并解锁": "Create and unlock",
    "解锁密码匣": "Unlock password vault",
    "使用设备验证解锁": "Unlock with device verification",
    "以便携模式打开": "Open in portable mode",
    "用本机恢复结果重建服务器副本": "Rebuild server copy from this device",
    "断开此设备": "Disconnect this device",
    "允许子域名自动填充": "Allow subdomain matching",
    "允许子域名匹配": "Allow subdomain matching",
    "显示密码": "Show password",
    "隐藏密码": "Hide password",
    "搜索网站或账号": "Search websites or accounts",
    "还没有保存的账号": "No saved accounts",
    "还没有账号": "No accounts yet",
    "没有匹配的账号": "No matching accounts",
    "两端已是最新": "Both sides are up to date",
    "已保存并同步": "Saved and synced",
    "已同步最新账号": "Latest accounts synced",
    "已同步": "Synced",
    "同步中": "Syncing",
    "同步失败": "Sync failed",
    "正在同步本机更改…": "Syncing local changes…",
    "正在检查本机服务…": "Checking local service…",
    "连接本机服务": "Connect to local service",
    "服务暂时离线": "Service is temporarily offline",
    "临时模式不会保存或同步账号更改。": "Temporary mode does not save or sync account changes.",
    "显示密码": "Show password",
    "选择语言": "Language",
    "中文": "中文",
    "English": "English",
    "密码建议": "Password suggestion",
    "修改密码建议": "Password suggestion for change",
    "新账号密码建议": "New account password suggestion",
    "独立随机": "Independent random",
    "参考已有密码": "Use an existing password as reference",
    "参考账号": "Reference account",
    "生成建议": "Generate suggestion",
    "建议密码，可修改": "Suggested password; editable",
    "填入页面": "Fill page",
    "操作成功，保存到密码匣": "Success, save to Password Vault",
    "修改成功，更新密码匣": "Changed, update Password Vault",
    "请选择要修改的账号": "Select the account to change",
    "邮箱或用户名": "Email or username",
    "选择要修改的账号": "Select the account to change",
    "用主密码保护你的登录信息，并按网站安全填充。": "Protect logins with a master password and fill them by site.",
    "本地网页与扩展共享解锁会话": "The local page and extension share the unlocked session",
    "保存和删除账号后会自动写入服务器。": "Account changes are written to the server automatically.",
    "服务器账号已替换；其他设备需重新加入": "Server accounts replaced; other devices must join again",
    "历史版本已恢复；其他设备需重新加入": "History restored; other devices must join again"
  };

  let language = "zh-CN";
  const originalText = new WeakMap();
  const originalAttrs = new WeakMap();
  let translating = false;

  function translateText(value) {
    if (language !== "en") return value;
    const trimmed = value.trim();
    if (!trimmed) return value;
    if (translations[trimmed]) return value.replace(trimmed, translations[trimmed]);
    let match = trimmed.match(/^(\d+) 个账号$/);
    if (match) return value.replace(trimmed, `${match[1]} account${match[1] === "1" ? "" : "s"}`);
    match = trimmed.match(/^首次使用 (\d+)\/(\d+)$/);
    if (match) return value.replace(trimmed, `First use ${match[1]}/${match[2]}`);
    match = trimmed.match(/^读取 (\d+) 条：新增 (\d+)，重复 (\d+)，跳过 (\d+)$/);
    if (match) return value.replace(trimmed, `Read ${match[1]}: ${match[2]} new, ${match[3]} duplicate, ${match[4]} skipped`);
    match = trimmed.match(/^重复密码 (\d+)$/);
    if (match) return value.replace(trimmed, `Reused passwords (${match[1]})`);
    match = trimmed.match(/^服务器版本 (\d+)$/);
    if (match) return value.replace(trimmed, `Server version ${match[1]}`);
    match = trimmed.match(/^版本 (\d+) · (.+)$/);
    if (match) return value.replace(trimmed, `Version ${match[1]} · ${match[2]}`);
    match = trimmed.match(/^已识别：(.+)。网站若有其他规则，请按报错调整。$/);
    if (match) return value.replace(trimmed, `Detected: ${match[1]}. Adjust it if the site reports other rules.`);
    return value;
  }

  function visit(root) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    translating = true;
    for (const node of nodes) {
      if (!originalText.has(node)) originalText.set(node, node.nodeValue);
      const source = originalText.get(node);
      node.nodeValue = language === "en" ? translateText(source) : source;
    }
    for (const element of root.querySelectorAll?.("[placeholder], [title], [aria-label]") || []) {
      let values = originalAttrs.get(element);
      if (!values) { values = {}; originalAttrs.set(element, values); }
      for (const name of ["placeholder", "title", "aria-label"]) {
        if (element.hasAttribute(name) && values[name] === undefined) values[name] = element.getAttribute(name);
        if (values[name] !== undefined) element.setAttribute(name, language === "en" ? translateText(values[name]) : values[name]);
      }
    }
    translating = false;
  }

  async function saveLanguage() {
    try {
      if (api?.storage?.local) await api.storage.local.set({ language });
      else localStorage.setItem("password-vault-language", language);
    } catch { /* A missing storage backend does not block the UI. */ }
  }

  async function loadLanguage() {
    try {
      const saved = api?.storage?.local
        ? (await api.storage.local.get("language")).language
        : localStorage.getItem("password-vault-language");
      if (saved === "en" || saved === "zh-CN") language = saved;
    } catch { /* Use Chinese when storage is unavailable. */ }
  }

  async function setLanguage(value) {
    language = value === "en" ? "en" : "zh-CN";
    document.documentElement.lang = language === "en" ? "en" : "zh-CN";
    const select = document.getElementById("languageSelect");
    if (select) select.value = language;
    document.title = translateText("密码匣");
    visit(document);
    await saveLanguage();
    document.dispatchEvent(new CustomEvent("password-vault-language-change", { detail: { language } }));
  }

  async function init() {
    await loadLanguage();
    const select = document.getElementById("languageSelect");
    if (select) {
      select.value = language;
      select.addEventListener("change", () => setLanguage(select.value));
    }
    document.documentElement.lang = language === "en" ? "en" : "zh-CN";
    document.title = translateText("密码匣");
    visit(document);
    new MutationObserver((mutations) => {
      if (translating) return;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) if (node.nodeType === Node.ELEMENT_NODE) visit(node);
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  globalThis.PasswordI18n = { init, setLanguage, getLanguage: () => language, t: translateText };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
