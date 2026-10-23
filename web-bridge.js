(function () {
  const REQUEST_CHANNEL = "password-vault-local-page-request";
  const RESPONSE_CHANNEL = "password-vault-local-page-response";
  const allowed = new Set(["sharedState", "sharedAccess", "sharedUnlock", "sharedTouch", "sharedLock", "sharedCommit"]);

  function send(message) {
    const api = globalThis.browser || globalThis.chrome;
    if (!api?.runtime?.sendMessage) return Promise.resolve({ error: "扩展未响应" });
    try {
      const result = api.runtime.sendMessage(message);
      if (result?.then) return result.catch((error) => ({ error: error.message || "扩展未响应" }));
      return new Promise((resolve) => api.runtime.sendMessage(message, (response) => {
        resolve(api.runtime.lastError ? { error: api.runtime.lastError.message } : (response || { error: "扩展未响应" }));
      }));
    } catch (error) {
      return Promise.resolve({ error: error.message || "扩展未响应" });
    }
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.channel !== REQUEST_CHANNEL || !allowed.has(data.type) || typeof data.id !== "string") return;
    const response = await send({ type: data.type, password: data.password, record: data.record,
      revision: data.revision });
    window.postMessage({ channel: RESPONSE_CHANNEL, id: data.id, response }, location.origin);
  });

  const api = globalThis.browser || globalThis.chrome;
  api?.runtime?.onMessage?.addListener((message) => {
    if (message?.type !== "sharedVaultChanged") return;
    window.postMessage({ channel: RESPONSE_CHANNEL, type: "changed", revision: message.revision }, location.origin);
  });

  window.postMessage({ channel: RESPONSE_CHANNEL, type: "ready" }, location.origin);
})();
