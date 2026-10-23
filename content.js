(() => {
  if (document.querySelector('meta[name="password-vault-web"]')) return;
  const promiseMessages = Boolean(globalThis.browser &&
    globalThis.browser.runtime.getURL("").startsWith("moz-extension:"));
  const extensionApi = promiseMessages ? globalThis.browser : (globalThis.chrome || globalThis.browser);
  const BUTTON_CLASS = "local-vault-key-button";
  const POPUP_ID = "local-vault-picker";
  const SAVE_PROMPT_ID = "local-vault-save-prompt";
  let pageState = { locked: true, entries: [] };
  let activeField = null;
  let activeSuggestionToken = null;
  let suggestionField = null;
  const keyButtons = new WeakMap();

  const send = (message) => promiseMessages
    ? extensionApi.runtime.sendMessage(message).catch((error) => ({ error: error.message || "扩展未响应" }))
    : new Promise((resolve) => {
      extensionApi.runtime.sendMessage(message, (response) => resolve(response || { error: "扩展未响应" }));
    });

  function showToast(message, isError = false) {
    let toast = document.getElementById("local-vault-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "local-vault-toast";
      document.documentElement.appendChild(toast);
    }
    toast.textContent = message;
    toast.dataset.error = isError ? "true" : "false";
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.remove(), 2600);
  }

  function closePicker() {
    document.getElementById(POPUP_ID)?.remove();
    activeField = null;
  }

  function usernameFieldFor(passwordField, strict = false) {
    const form = passwordField.form || passwordField.closest("form") || document;
    const candidates = [...form.querySelectorAll("input:not([type=password]):not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio])")];
    return candidates.find((input) => /user|email|account|login|name|用户|账号|邮箱/i.test(
      `${input.name} ${input.id} ${input.autocomplete} ${input.placeholder}`
    )) || (strict ? null : candidates[0]);
  }

  function passwordFieldFor(field) {
    if (field instanceof HTMLInputElement && field.type === "password") return field;
    const form = field?.form || field?.closest?.("form") || document;
    return form.querySelector('input[type="password"]');
  }

  function passwordFormKind(field) {
    const form = field.form || field.closest("form");
    if (!form) return field.autocomplete === "new-password" ? "register" : null;
    const passwords = [...form.querySelectorAll('input[type="password"]')];
    const identity = `${form.id} ${form.className} ${form.getAttribute("action") || ""} ${form.querySelector('button[type="submit"],input[type="submit"]')?.textContent || ""}`;
    const hasCurrent = passwords.some((input) => /current-password/i.test(input.autocomplete) || /old|current|原密码|旧密码/i.test(`${input.name} ${input.id} ${input.placeholder}`));
    const hasNew = passwords.some((input) => input.autocomplete === "new-password" || /new|confirm|repeat|新密码|确认密码/i.test(`${input.name} ${input.id} ${input.placeholder}`));
    if ((hasCurrent && hasNew) || /change.?password|update.?password|reset.?password|forgot.?password|修改密码|更改密码|重置密码|找回密码/i.test(identity)) return "change";
    if (field.autocomplete === "new-password") return "register";
    if (/register|sign.?up|create.?account|注册|创建账号|创建账户/i.test(identity)) return "register";
    return passwords.length >= 2 && passwords.some((input) => /confirm|repeat|again|确认|重复/i.test(`${input.name} ${input.id} ${input.placeholder}`)) ? "register" : null;
  }

  function isCurrentPasswordField(field, kind) {
    if (kind !== "change") return false;
    if (field.autocomplete === "current-password" || /old|current|原密码|旧密码/i.test(`${field.name} ${field.id} ${field.placeholder}`)) return true;
    const form = field.form || field.closest("form");
    const passwords = [...(form?.querySelectorAll('input[type="password"]') || [])];
    return passwords.length >= 2 && passwords[0] === field && field.autocomplete !== "new-password";
  }

  function suggestionPrimaryField(field, kind) {
    const form = field.form || field.closest("form");
    if (!form) return field;
    return [...form.querySelectorAll('input[type="password"]')].find((input) => (
      !isCurrentPasswordField(input, kind) &&
      !/confirm|repeat|again|确认|重复/i.test(`${input.name} ${input.id} ${input.placeholder}`)
    )) || field;
  }

  function registrationPolicy(field) {
    const form = field.form || field.closest("form");
    const described = (field.getAttribute("aria-describedby") || "").split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent || "");
    const related = [field.validationMessage, ...described,
      ...[...(field.labels || [])].map((label) => label.textContent),
      ...[...(field.parentElement?.querySelectorAll("small,.hint,.help-text") || [])].slice(0, 6).map((node) => node.textContent),
      ...[...(form?.querySelectorAll('[role="alert"],[aria-live],.error,.invalid-feedback') || [])].slice(0, 8).map((node) => node.textContent)
    ].map((part) => String(part || "").slice(0, 500)).join(" ");
    const minimum = related.match(/(?:至少|不少于|最少|at least|minimum)\s*(\d{1,2})\s*(?:个|位|字符|characters?|chars?)?/i);
    const maximum = related.match(/(?:最多|不超过|至多|at most|maximum)\s*(\d{1,2})\s*(?:个|位|字符|characters?|chars?)?/i);
    const requiresTypes = /必须|需要|包含|包括|至少|must|required?|include|contain/i.test(related);
    const maxLength = Math.min(field.maxLength > 0 ? field.maxLength : 64, maximum ? Number(maximum[1]) : 64);
    return {
      minLength: Math.max(8, field.minLength > 0 ? field.minLength : 0, minimum ? Number(minimum[1]) : 0, Math.min(12, maxLength)),
      maxLength,
      requireUpper: requiresTypes && /大写|upper.?case|capital letter/i.test(related),
      requireLower: requiresTypes && /小写|lower.?case/i.test(related),
      requireDigit: requiresTypes && /数字|digit|number/i.test(related),
      requireSymbol: requiresTypes && /特殊字符|符号|special character|symbol/i.test(related),
      alphanumericOnly: /(?:只能|仅限|only)[^。.!\n]{0,50}(?:字母和数字|字母、数字|letters? and numbers?|alphanumeric)/i.test(related)
    };
  }

  function suggestionValid(field, password) {
    if (!field?.isConnected || field.type !== "password") return { error: "注册表单已变化，请重新打开密码建议" };
    const policy = registrationPolicy(field);
    if (password.length < policy.minLength || password.length > policy.maxLength) return { valid: false };
    const probe = document.createElement("input");
    probe.type = "password";
    if (field.hasAttribute("pattern") && field.pattern) probe.pattern = field.pattern;
    probe.value = password;
    return { valid: !probe.validity.patternMismatch };
  }

  function setInputValue(input, value) {
    if (!input) return;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function visiblePasswordField() {
    return [...document.querySelectorAll('input[type="password"]')].some((field) => (
      field.getClientRects().length > 0 && getComputedStyle(field).visibility !== "hidden"
    ));
  }

  function remembersPassword(form) {
    return [...form.querySelectorAll('input[type="checkbox"],[role="checkbox"]')].some((input) => {
      if (!(input.checked || input.getAttribute("aria-checked") === "true")) return false;
      const label = input.labels?.[0]?.textContent || input.closest("label")?.textContent || "";
      return /remember|keep.?me.?signed|stay.?signed|记住|保持登录|自动登录/i.test(
        `${input.name} ${input.id} ${input.getAttribute("aria-label") || ""} ${label}`
      );
    });
  }

  function successEvidence() {
    const status = [...document.querySelectorAll('[role="alert"],[role="status"],[aria-live],.toast,.notification,.message')]
      .filter((node) => node.getClientRects().length > 0)
      .map((node) => (node.textContent || "").slice(0, 300)).join(" ");
    return /密码.{0,12}(修改|更改|重置|更新)成功|(?:password|account).{0,20}(?:changed|updated|reset|success)|登录成功|signed in successfully|successfully signed in/i.test(status);
  }

  function failureEvidence() {
    if (/\/(?:error|failed|failure)(?:\/|$)/i.test(location.pathname)) return true;
    const alerts = [...document.querySelectorAll('[role="alert"],.error,.invalid-feedback')]
      .filter((node) => node.getClientRects().length > 0)
      .map((node) => (node.textContent || "").slice(0, 300)).join(" ");
    return /密码错误|密码不正确|登录失败|修改失败|更改失败|账号或密码错误|incorrect password|invalid password|login failed|password change failed/i.test(alerts);
  }

  function showSavePrompt(pending) {
    if (document.getElementById(SAVE_PROMPT_ID)) return;
    const prompt = document.createElement("div");
    prompt.id = SAVE_PROMPT_ID;
    prompt.setAttribute("role", "dialog");
    prompt.setAttribute("aria-label", "保存登录信息到密码匣");
    const title = document.createElement("strong");
    title.textContent = pending.action === "update" ? "更新密码匣中的密码？" : "保存到密码匣？";
    const site = document.createElement("span");
    site.textContent = pending.site;
    const account = document.createElement("input");
    account.type = "text";
    account.value = pending.username;
    account.placeholder = "登录邮箱或用户名";
    account.setAttribute("aria-label", "登录账号");
    const actions = document.createElement("div");
    actions.className = "local-vault-save-actions";
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.textContent = "不保存";
    dismiss.addEventListener("click", async () => {
      await send({ type: "discardPendingLogin", token: pending.token });
      prompt.remove();
    });
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = pending.action === "update" ? "更新" : "保存";
    save.addEventListener("click", async () => {
      save.disabled = true;
      const result = await send({ type: "confirmPendingLogin", token: pending.token, username: account.value });
      save.disabled = false;
      if (result.error) return showToast(result.error, true);
      prompt.remove();
      showToast(result.updated ? "密码匣中的密码已更新" : "登录信息已加密保存");
    });
    actions.append(dismiss, save);
    prompt.append(title, site, account, actions);
    document.documentElement.appendChild(prompt);
  }

  async function checkPendingLogin() {
    if (visiblePasswordField() || document.getElementById(SAVE_PROMPT_ID)) return;
    const result = await send({ type: "getPendingLogin",
      successEvidence: successEvidence(), failureEvidence: failureEvidence() });
    if (result.saved) {
      showToast(result.updated ? "密码匣中的密码已更新" : "登录信息已加密保存");
      return;
    }
    if (result.pending && !visiblePasswordField()) showSavePrompt(result.pending);
  }

  function schedulePendingCheck(delay = 500) {
    clearTimeout(schedulePendingCheck.timer);
    schedulePendingCheck.timer = setTimeout(checkPendingLogin, delay);
  }

  async function stageFormLogin(form, preferredField = null) {
    const passwords = [...form.querySelectorAll('input[type="password"]')].filter((input) => (
      input.getClientRects().length > 0 && input.value
    ));
    if (!passwords.length) return;
    const kind = passwordFormKind(preferredField || passwords[0]);
    const field = kind === "change" || kind === "register"
      ? suggestionPrimaryField(preferredField || passwords[0], kind) : (preferredField || passwords[0]);
    if (!field.value) return;
    const currentPassword = kind === "change"
      ? passwords.find((input) => isCurrentPasswordField(input, kind))?.value || "" : "";
    const confirmation = passwords.find((input) => input !== field &&
      /confirm|repeat|again|确认|重复/i.test(`${input.name} ${input.id} ${input.placeholder} ${input.autocomplete}`));
    if (confirmation && confirmation.value !== field.value) return;
    const username = usernameFieldFor(field, kind === "change")?.value || "";
    const result = await send({ type: "stageLogin", username, password: field.value,
      currentPassword, kind: kind || "login", remember: remembersPassword(form) });
    if (result.staged) schedulePendingCheck(1200);
  }

  async function fill(entry, passwordField) {
    const resolved = await send({ type: "getEntry", id: entry.id });
    if (resolved.error || !resolved.entry) {
      closePicker();
      const message = resolved.error === "LOCKED" ? "密码匣已自动锁定，请重新解锁" : (resolved.error || "无法填充");
      showToast(message, true);
      return;
    }
    entry = resolved.entry;
    const username = usernameFieldFor(passwordField);
    setInputValue(username, entry.username);
    setInputValue(passwordField, entry.password);
    passwordField.focus();
    closePicker();
    showToast(`已填充 ${entry.name}`);
  }

  async function showPicker(field) {
    pageState = await send({ type: "getMatches" });
    closePicker();
    if (pageState.error) {
      showToast(pageState.error, true);
      return;
    }
    const kind = passwordFormKind(field);
    const suggestion = kind && !isCurrentPasswordField(field, kind);
    const primaryField = suggestion ? suggestionPrimaryField(field, kind) : field;
    if (!suggestion && !pageState.locked && !pageState.unsupported && location.protocol === "https:" && pageState.entries.length === 1) {
      await fill(pageState.entries[0], field);
      return;
    }
    activeField = field;
    const popup = document.createElement("div");
    popup.id = POPUP_ID;
    const rect = field.getBoundingClientRect();
    popup.style.setProperty("top", `${Math.min(window.innerHeight - 16, rect.bottom + 8)}px`, "important");
    popup.style.setProperty("left", `${Math.max(12, Math.min(window.innerWidth - 320, rect.right - 300))}px`, "important");
    if (pageState.unsupported) {
      popup.innerHTML = `<div class="local-vault-empty">当前页面不支持填充</div>`;
    } else if (pageState.locked) {
      popup.innerHTML = `<div class="local-vault-empty">先打开扩展并解锁保险库</div>`;
    } else {
      if (pageState.insecure) {
        const warning = document.createElement("div");
        warning.className = "local-vault-warning";
        warning.textContent = "此页面使用 HTTP，密码可能被截获。请确认地址后再填充。";
        popup.appendChild(warning);
      }
      if (suggestion) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "local-vault-suggest";
        button.textContent = kind === "change" ? "为修改密码生成建议" : "为新账号建议密码";
        button.addEventListener("click", async () => {
          const result = await send({ type: "openSuggestion", kind, policy: registrationPolicy(primaryField) });
          if (result.error) showToast(result.error, true);
          else {
            suggestionField = primaryField;
            activeSuggestionToken = result.token;
            closePicker();
          }
        });
        popup.appendChild(button);
      }
      if (pageState.entries.length) {
        const title = document.createElement("div");
        title.className = "local-vault-picker-title";
        title.textContent = suggestion ? "已有账号" : "选择要填充的账号";
        popup.appendChild(title);
      } else if (!suggestion) {
        const empty = document.createElement("div");
        empty.className = "local-vault-empty";
        empty.textContent = "没有匹配这个网站的账号";
        popup.appendChild(empty);
      }
      pageState.entries.forEach((entry) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "local-vault-entry";
        button.innerHTML = `<strong></strong><span></span>`;
        button.querySelector("strong").textContent = entry.name;
        button.querySelector("span").textContent = entry.username;
        button.addEventListener("click", () => fill(entry, field));
        popup.appendChild(button);
      });
    }
    document.documentElement.appendChild(popup);
    setTimeout(() => document.addEventListener("pointerdown", outside, { once: true }), 0);
    function outside(event) {
      if (!popup.contains(event.target) && event.target !== field) closePicker();
    }
  }

  function addButton(field) {
    if (keyButtons.has(field)) {
      positionButton(field, keyButtons.get(field));
      return;
    }
    if (field.disabled || field.readOnly) return;
    field.dataset.localVaultAttached = "true";
    const parent = field.parentElement;
    if (!parent) return;
    if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
    const button = document.createElement("button");
    button.type = "button";
    button.className = BUTTON_CLASS;
    button.title = "从密码匣填充";
    button.setAttribute("aria-label", "从密码匣填充");
    button.textContent = "🔑";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!event.isTrusted) return;
      showPicker(field);
    });
    parent.appendChild(button);
    keyButtons.set(field, button);
    positionButton(field, button);
  }

  function positionButton(field, button) {
    const parent = button.parentElement;
    if (!parent || !field.isConnected) return;
    const input = field.getBoundingClientRect();
    const box = parent.getBoundingClientRect();
    button.style.setProperty("top", `${input.top - box.top + parent.scrollTop + input.height / 2}px`, "important");
    button.style.setProperty("left", `${input.right - box.left + parent.scrollLeft - 34}px`, "important");
  }

  function scan() {
    document.querySelectorAll('input[type="password"]').forEach(addButton);
  }

  async function refresh() {
    pageState = await send({ type: "getMatches" });
  }

  refresh();
  scan();
  new MutationObserver(() => {
    scan();
    schedulePendingCheck();
  }).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("submit", (event) => {
    if (event.isTrusted && event.target instanceof HTMLFormElement) stageFormLogin(event.target);
  }, true);
  document.addEventListener("click", (event) => {
    if (!event.isTrusted) return;
    const button = event.target.closest?.('button,input[type="button"]');
    if (!button || button.type === "submit" || button.classList.contains(BUTTON_CLASS)) return;
    if (!/login|log in|sign in|sign up|register|change.?password|update.?password|continue|登录|注册|修改密码|更改密码|更新密码|继续/i.test(button.textContent || button.value || "")) return;
    const form = button.closest("form");
    if (form) stageFormLogin(form);
    else {
      const field = [...document.querySelectorAll('input[type="password"]')].find((input) => (
        input.value && input.getClientRects().length > 0
      ));
      if (field) stageFormLogin(document, field);
    }
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.isTrusted && event.key === "Enter" && event.target instanceof HTMLInputElement &&
        event.target.type === "password") {
      stageFormLogin(event.target.form || event.target.closest("form") || document, event.target);
    }
  }, true);
  schedulePendingCheck(900);
  window.addEventListener("pageshow", () => schedulePendingCheck(900));
  window.addEventListener("focus", refresh);
  window.addEventListener("resize", scan);
  window.addEventListener("scroll", scan, true);
  extensionApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "checkSuggestion" || message.type === "applySuggestion") {
      if (!message.token || message.token !== activeSuggestionToken) {
        sendResponse({ error: "建议窗口与当前表单不匹配" });
        return;
      }
      const check = suggestionValid(suggestionField, String(message.password || ""));
      if (message.type === "checkSuggestion" || !check.valid) {
        sendResponse(message.type === "checkSuggestion" ? check : { error: check.error || "建议密码不符合当前网站规则" });
        return;
      }
      const field = suggestionField;
      const form = field.form || field.closest("form") || document;
      const current = [...form.querySelectorAll('input[type="password"]')].find((input) => (
        input !== field && isCurrentPasswordField(input, "change")
      ));
      const confirmation = [...form.querySelectorAll('input[type="password"]')].find((input) => (
        input !== field && input.autocomplete !== "current-password" &&
        /confirm|repeat|again|确认|重复/i.test(`${input.name} ${input.id} ${input.placeholder} ${input.autocomplete}`)
      ));
      if (message.currentPassword && current) setInputValue(current, message.currentPassword);
      setInputValue(field, message.password);
      setInputValue(confirmation, message.password);
      field.focus();
      showToast("已填入新密码；网站确认成功后将更新密码匣");
      sendResponse({ ok: true });
      return;
    }
    if (message.type !== "openPicker") return;
    const field = passwordFieldFor(document.activeElement);
    if (!field) {
      showToast("请先把光标放在密码输入框", true);
      return;
    }
    showPicker(field);
  });
})();
