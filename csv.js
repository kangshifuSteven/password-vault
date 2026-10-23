(function () {
  function detectDelimiter(text) {
    const firstLine = String(text || "").split(/\r?\n/, 1)[0];
    const candidates = [",", ";", "\t"];
    return candidates.sort((a, b) => {
      const count = (line, delimiter) => line.split(delimiter).length - 1;
      return count(firstLine, b) - count(firstLine, a);
    })[0];
  }

  function parseRows(text, delimiter) {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    const source = String(text || "").replace(/^\uFEFF/, "");

    for (let index = 0; index < source.length; index += 1) {
      const character = source[index];
      if (character === '"') {
        if (quoted && source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = !quoted;
        }
      } else if (character === delimiter && !quoted) {
        row.push(field);
        field = "";
      } else if ((character === "\n" || character === "\r") && !quoted) {
        if (character === "\r" && source[index + 1] === "\n") index += 1;
        row.push(field);
        if (row.some((value) => value.trim())) rows.push(row);
        row = [];
        field = "";
      } else {
        field += character;
      }
    }
    if (field || row.length) {
      row.push(field);
      if (row.some((value) => value.trim())) rows.push(row);
    }
    return rows;
  }

  function normalizeHeader(value) {
    return String(value || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  }

  function valueFor(row, headerMap, aliases) {
    for (const alias of aliases) {
      const index = headerMap.get(normalizeHeader(alias));
      if (index !== undefined) return String(row[index] || "").trim();
    }
    return "";
  }

  function parse(text) {
    const rows = parseRows(text, detectDelimiter(text));
    if (!rows.length) throw new Error("CSV 文件为空");
    const headers = rows.shift().map(normalizeHeader);
    const headerMap = new Map(headers.map((header, index) => [header, index]));
    const hasSite = ["url", "uri", "loginuri", "website", "websiteurl", "origin"].some((key) => headerMap.has(key));
    const hasUsername = ["username", "loginusername", "user", "email"].some((key) => headerMap.has(key));
    const hasPassword = ["password", "loginpassword"].some((key) => headerMap.has(key));
    if (!hasSite || !hasUsername || !hasPassword) {
      throw new Error("CSV 需要包含网站、用户名和密码列");
    }

    const entries = [];
    let skipped = 0;
    for (const row of rows) {
      const site = valueFor(row, headerMap, ["url", "uri", "login_uri", "website", "website_url", "origin"]);
      const username = valueFor(row, headerMap, ["username", "login_username", "user", "email"]);
      const password = valueFor(row, headerMap, ["password", "login_password"]);
      if (!site || !username || !password) {
        skipped += 1;
        continue;
      }
      const name = valueFor(row, headerMap, ["name", "title", "login_name"]) || site;
      entries.push({ name, site, username, password, subdomains: false });
    }
    return { entries, skipped, total: rows.length };
  }

  globalThis.PasswordCsv = { parse };
})();
