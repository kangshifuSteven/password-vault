(function () {
  function endpoint(value) {
    let url;
    try { url = new URL(String(value || "").trim()); }
    catch { throw new Error("服务器地址无效"); }
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new Error("服务器地址只填写来源，例如 https://vault.example.com");
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      throw new Error("远程服务器必须使用 HTTPS；HTTP 只允许本机地址");
    }
    return url.origin;
  }

  function validRecord(record) {
    return record && record.version === 1 && record.kdf === "PBKDF2-SHA-256" &&
      Number.isInteger(record.iterations) && record.iterations >= 250000 &&
      typeof record.salt === "string" && typeof record.iv === "string" &&
      typeof record.ciphertext === "string";
  }

  function same(a, b) {
    const canonical = (value) => {
      if (Array.isArray(value)) return value.map(canonical);
      if (value && typeof value === "object") {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
      }
      return value;
    };
    return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
  }

  function equivalentVault(a, b) {
    return a?.version === b?.version && same(
      [...a.entries].sort((x, y) => x.id.localeCompare(y.id)),
      [...b.entries].sort((x, y) => x.id.localeCompare(y.id))
    );
  }

  function merge(base, local, remote, decisions = {}) {
    if (![base, local, remote].every((vault) => vault?.version === 1 && Array.isArray(vault.entries))) {
      throw new Error("同步保险库格式无效");
    }
    const byId = (entries) => new Map(entries.map((entry) => [entry.id, entry]));
    const b = byId(base.entries);
    const l = byId(local.entries);
    const r = byId(remote.entries);
    const ids = new Set([...b.keys(), ...l.keys(), ...r.keys()]);
    const result = [];
    const conflicts = [];
    for (const id of ids) {
      const previous = b.get(id);
      const left = l.get(id);
      const right = r.get(id);
      let chosen;
      if (same(left, right)) chosen = left;
      else if (same(left, previous)) chosen = right;
      else if (same(right, previous)) chosen = left;
      else {
        const decision = decisions[id];
        if (!["local", "remote", "both"].includes(decision) ||
            (decision === "both" && (!left || !right))) {
          conflicts.push({ id, local: left ? { name: left.name, site: left.site, username: left.username } : null,
            remote: right ? { name: right.name, site: right.site, username: right.username } : null });
          continue;
        }
        chosen = decision === "remote" ? right : left;
        if (decision === "both") {
          result.push({ ...right, id: crypto.randomUUID(), name: `${right.name} (冲突副本)` });
        }
      }
      if (chosen) result.push(chosen);
    }
    return { vault: { version: 1, entries: result }, conflicts };
  }

  function combine(imported, existing) {
    if (![imported, existing].every((vault) => vault?.version === 1 && Array.isArray(vault.entries))) {
      throw new Error("保险库格式无效");
    }
    const entries = existing.entries.map((entry) => ({ ...entry }));
    const changes = [];
    const identity = (entry) => JSON.stringify([
      entry.kind === "app" ? "app" : "site",
      String(entry.site || "").toLocaleLowerCase(),
      String(entry.username || "")
    ]);
    const comparable = (entry) => {
      const { id, updatedAt, ...value } = entry;
      return value;
    };
    for (const entry of imported.entries) {
      const index = entries.findIndex((item) => item.id === entry.id || identity(item) === identity(entry));
      let status;
      if (index < 0) {
        entries.push({ ...entry });
        status = "added";
      } else if (same(comparable(entries[index]), comparable(entry))) {
        status = "same";
      } else {
        entries[index] = { ...entry, id: entries[index].id, updatedAt: new Date().toISOString() };
        status = "updated";
      }
      changes.push({ status, name: entry.name, site: entry.site, username: entry.username });
    }
    return { vault: { version: 1, entries }, changes,
      added: changes.filter((item) => item.status === "added").length,
      updated: changes.filter((item) => item.status === "updated").length,
      same: changes.filter((item) => item.status === "same").length };
  }

  globalThis.VaultSync = { endpoint, validRecord, merge, combine, same, equivalentVault };
})();
