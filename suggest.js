const promiseMessages = Boolean(globalThis.browser &&
  globalThis.browser.runtime.getURL("").startsWith("moz-extension:"));
const extensionApi = promiseMessages ? globalThis.browser : (globalThis.chrome || globalThis.browser);
const $ = (id) => document.getElementById(id);
const token = location.hash.slice(1);
let context = null;
let mode = "random";
let appliedPassword = "";
let appliedAccountId = "";

function send(message) {
  if (promiseMessages) {
    return extensionApi.runtime.sendMessage(message)
      .catch((error) => ({ error: error.message || "扩展未响应" }));
  }
  return new Promise((resolve) => {
    extensionApi.runtime.sendMessage(message, (response) => {
      resolve(extensionApi.runtime.lastError ? { error: extensionApi.runtime.lastError.message } : (response || { error: "扩展未响应" }));
    });
  });
}

function notice(message = "") {
  $("notice").textContent = message;
}

function selectMode(next) {
  mode = next;
  $("randomMode").setAttribute("aria-pressed", String(next === "random"));
  $("referenceMode").setAttribute("aria-pressed", String(next === "reference"));
  $("referenceOptions").hidden = next !== "reference";
  $("result").hidden = true;
  $("save").hidden = true;
  $("password").value = "";
  appliedPassword = "";
  appliedAccountId = "";
  notice();
}

$("randomMode").addEventListener("click", () => selectMode("random"));
$("referenceMode").addEventListener("click", () => selectMode("reference"));
$("account").addEventListener("change", () => {
  appliedPassword = "";
  appliedAccountId = "";
  $("save").hidden = true;
  if ($("account").value) $("source").value = $("account").value;
});
$("generate").addEventListener("click", async () => {
  $("generate").disabled = true;
  notice();
  const result = await send({
    type: "createSuggestion", token, mode, sourceId: $("source").value
  });
  $("generate").disabled = false;
  if (result.error) return notice(result.error);
  $("password").value = result.password;
  $("password").type = "password";
  $("toggle").setAttribute("aria-label", "显示密码");
  $("toggle").title = "显示密码";
  $("eye").hidden = false;
  $("eyeOff").hidden = true;
  $("result").hidden = false;
  $("save").hidden = true;
  appliedPassword = "";
  appliedAccountId = "";
});
$("toggle").addEventListener("click", () => {
  const visible = $("password").type === "password";
  $("password").type = visible ? "text" : "password";
  $("toggle").setAttribute("aria-label", visible ? "隐藏密码" : "显示密码");
  $("toggle").title = visible ? "隐藏密码" : "显示密码";
  $("eye").hidden = visible;
  $("eyeOff").hidden = !visible;
});
$("password").addEventListener("input", () => {
  appliedPassword = "";
  appliedAccountId = "";
  $("save").hidden = true;
});
$("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("password").value);
    notice("已复制，请注意剪贴板可能被其他程序读取");
  } catch {
    notice("复制失败，请手动选择密码");
  }
});
$("apply").addEventListener("click", async () => {
  const value = $("password").value;
  const accountId = context.kind === "change" ? $("account").value : "";
  if (context.kind === "change" && context.accounts.length && !accountId) return notice("请选择要修改的账号");
  const result = await send({ type: "applySuggestion", token, password: value, accountId });
  if (result.error) return notice(result.error);
  appliedPassword = value;
  appliedAccountId = accountId;
  $("save").hidden = false;
  $("saveUsername").hidden = Boolean(appliedAccountId);
  $("saveHint").textContent = context.kind === "change"
    ? "网站确认成功后会尝试自动更新；未识别时可在这里保存。"
    : "注册成功后会尝试提示保存；未识别时可在这里保存。";
  $("saveEntry").textContent = appliedAccountId ? "修改成功，更新密码匣" : "操作成功，保存到密码匣";
  notice("已填入页面。请先确认网站操作成功。");
});
$("saveEntry").addEventListener("click", async () => {
  if (!appliedPassword || appliedPassword !== $("password").value) return notice("请先把当前密码填入页面");
  let result;
  if (appliedAccountId) {
    result = await send({ type: "updateSuggestedEntry", token, accountId: appliedAccountId, password: appliedPassword });
  } else {
    const username = $("username").value.trim();
    if (!username) return notice("请填写网站使用的邮箱或用户名");
    result = await send({
      type: "saveEntry",
      entry: { name: context.hostname, site: context.hostname, username, password: appliedPassword }
    });
  }
  if (result.error) return notice(result.error);
  notice(result.unchanged ? "密码匣已保存该密码" : appliedAccountId ? "密码匣中的账号已更新" : "已保存到密码匣");
  $("saveEntry").disabled = true;
});

async function init() {
  const result = await send({ type: "getSuggestionContext", token });
  if (result.error) return notice(result.error);
  context = result;
  $("suggestion").hidden = false;
  $("heading").textContent = result.kind === "change" ? "修改密码建议" : "新账号密码建议";
  $("site").textContent = result.hostname;
  $("insecure").hidden = !result.insecure;
  const policy = result.policy;
  const rules = [`${policy.minLength}–${policy.maxLength} 位`];
  if (policy.requireUpper) rules.push("大写字母");
  if (policy.requireLower) rules.push("小写字母");
  if (policy.requireDigit) rules.push("数字");
  if (policy.requireSymbol) rules.push("特殊字符");
  if (policy.alphanumericOnly) rules.push("仅字母和数字");
  $("rules").textContent = `已识别：${rules.join("、")}。网站若有其他规则，请按报错调整。`;
  const option = document.createElement("option");
  option.value = "";
  option.textContent = "选择账号";
  $("source").appendChild(option);
  for (const entry of result.sources) {
    const item = document.createElement("option");
    item.value = entry.id;
    item.textContent = `${entry.name} (${entry.site})`;
    $("source").appendChild(item);
  }
  $("referenceMode").disabled = result.sources.length === 0;
  if (result.kind === "change" && result.accounts.length) {
    $("accountOptions").hidden = false;
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "选择要修改的账号";
    $("account").appendChild(placeholder);
    for (const entry of result.accounts) {
      const item = document.createElement("option");
      item.value = entry.id;
      item.textContent = `${entry.username} (${entry.site})`;
      $("account").appendChild(item);
    }
    if (result.accounts.length === 1) {
      $("account").value = result.accounts[0].id;
      $("source").value = result.accounts[0].id;
    }
  }
}

async function checkLockState() {
  const state = await send({ type: "getState" });
  if (state.mode === "unlocked") return;
  $("password").value = "";
  appliedPassword = "";
  $("result").hidden = true;
  $("suggestion").hidden = true;
  notice("密码匣已锁定。解锁后请从注册页重新打开建议。");
}

setInterval(checkLockState, 2000);
window.addEventListener("focus", checkLockState);
init();
