(function () {
  const ITERATIONS = 600000;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function bytesToBase64(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  function base64ToBytes(value) {
    const binary = atob(value);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }

  function randomBytes(length) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return bytes;
  }

  async function deriveKey(password, salt, iterations = ITERATIONS, extractable = false) {
    const material = await crypto.subtle.importKey(
      "raw",
      encoder.encode(password),
      "PBKDF2",
      false,
      ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt,
        iterations,
        hash: "SHA-256"
      },
      material,
      { name: "AES-GCM", length: 256 },
      extractable,
      ["encrypt", "decrypt"]
    );
  }

  async function encryptWithKey(key, value) {
    const iv = randomBytes(12);
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      encoder.encode(JSON.stringify(value))
    );
    return {
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(encrypted))
    };
  }

  async function decryptWithKey(key, record) {
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(record.iv) },
      key,
      base64ToBytes(record.ciphertext)
    );
    return JSON.parse(decoder.decode(decrypted));
  }

  async function createRecord(password, value) {
    const salt = randomBytes(16);
    const key = await deriveKey(password, salt);
    const encrypted = await encryptWithKey(key, value);
    return {
      version: 1,
      kdf: "PBKDF2-SHA-256",
      iterations: ITERATIONS,
      salt: bytesToBase64(salt),
      ...encrypted
    };
  }

  async function createRecoveryRecord(value) {
    const pair = await crypto.subtle.generateKey(
      { name: "RSA-OAEP", modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["encrypt", "decrypt"]
    );
    const secret = randomBytes(32);
    const key = await crypto.subtle.importKey("raw", secret, "AES-GCM", false, ["encrypt", "decrypt"]);
    const encrypted = await encryptWithKey(key, value);
    const keyId = [...randomBytes(16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return {
      record: {
        version: 2, scheme: "RSA-OAEP-3072+AES-256-GCM", keyId,
        publicKey: bytesToBase64(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey))),
        wrappedKey: bytesToBase64(new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, pair.publicKey, secret))),
        ...encrypted
      },
      privateKey: {
        version: 1, kind: "password-vault-recovery-private-key", keyId,
        algorithm: "RSA-OAEP-3072-SHA-256",
        pkcs8: bytesToBase64(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)))
      }
    };
  }

  async function openRecoveryRecord(privateKeyFile, record) {
    if (record?.version === 1 && record?.kdf === "PBKDF2-SHA-256") {
      return openRecord(privateKeyFile, record);
    }
    if (record?.version !== 2 || record?.scheme !== "RSA-OAEP-3072+AES-256-GCM" ||
        typeof record.iv !== "string" || typeof record.ciphertext !== "string" ||
        typeof record.wrappedKey !== "string" || !/^[0-9a-f]{32}$/.test(record.keyId) ||
        privateKeyFile?.kind !== "password-vault-recovery-private-key" ||
        privateKeyFile.algorithm !== "RSA-OAEP-3072-SHA-256" ||
        privateKeyFile.keyId !== record.keyId || typeof privateKeyFile.pkcs8 !== "string") {
      throw new Error("恢复文件或私钥文件格式无效");
    }
    const privateKey = await crypto.subtle.importKey(
      "pkcs8", base64ToBytes(privateKeyFile.pkcs8),
      { name: "RSA-OAEP", hash: "SHA-256" }, false, ["decrypt"]
    );
    const secret = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, privateKey, base64ToBytes(record.wrappedKey));
    const key = await crypto.subtle.importKey("raw", secret, "AES-GCM", true, ["encrypt", "decrypt"]);
    return { key, value: await decryptWithKey(key, record) };
  }

  async function openRecord(password, record) {
    const salt = base64ToBytes(record.salt);
    const key = await deriveKey(password, salt, record.iterations || ITERATIONS, true);
    const value = await decryptWithKey(key, record);
    return { key, value };
  }

  async function exportKey(key) {
    return bytesToBase64(new Uint8Array(await crypto.subtle.exportKey("raw", key)));
  }

  async function importKey(value) {
    return crypto.subtle.importKey("raw", base64ToBytes(value), "AES-GCM", true, ["encrypt", "decrypt"]);
  }

  async function prfKey(value) {
    return crypto.subtle.importKey("raw", base64ToBytes(value), "AES-GCM", false, ["encrypt", "decrypt"]);
  }

  function generatePassword(length = 24) {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*_-+=";
    const result = [];
    const max = 256 - (256 % alphabet.length);
    while (result.length < length) {
      const bytes = randomBytes(length * 2);
      for (const byte of bytes) {
        if (byte >= max) continue;
        result.push(alphabet[byte % alphabet.length]);
        if (result.length === length) break;
      }
    }
    return result.join("");
  }

  function randomIndex(limit) {
    const ceiling = 256 - (256 % limit);
    let value;
    do { value = randomBytes(1)[0]; } while (value >= ceiling);
    return value % limit;
  }

  function suggestedPassword(policy, sourcePassword = "", host = "") {
    const groups = {
      upper: "ABCDEFGHJKLMNPQRSTUVWXYZ",
      lower: "abcdefghijkmnopqrstuvwxyz",
      digit: "23456789",
      symbol: "!@#$%_-+"
    };
    const minimum = Math.max(8, Math.min(64, Number(policy.minLength) || 12));
    const maximum = Math.max(0, Math.min(64, Number(policy.maxLength) || 64));
    if (maximum < minimum || maximum < 8) throw new Error("网站限制的密码长度过短或互相冲突，请手动设置");
    if (policy.alphanumericOnly && policy.requireSymbol) throw new Error("网站的字符要求互相冲突，请手动设置");
    const length = Math.min(maximum, Math.max(minimum, 20));
    const alphabet = groups.upper + groups.lower + groups.digit + (policy.alphanumericOnly ? "" : groups.symbol);
    if (sourcePassword) {
      const source = String(sourcePassword).replace(policy.alphanumericOnly ? /[^A-Za-z0-9]/g : /[^A-Za-z0-9!@#$%_+\-]/g, "");
      const labels = normalizeHost(host).split(".");
      const base = labels.length > 1 ? labels[labels.length - 2] : labels[0];
      const site = `${base.replace(/[^A-Za-z0-9]/g, "").slice(0, 4)}${labels.length > 1 ? labels.at(-1).slice(0, 1) : ""}`;
      if (source.length < 8 || !site || maximum < 12) {
        throw new Error("这个账号或网站的规则不适合易记建议，请使用独立随机密码");
      }
      const head = source.slice(0, 4);
      let tail = source.slice(-4);
      const missing = () => [
        ["requireUpper", groups.upper, "A"], ["requireLower", groups.lower, "a"],
        ["requireDigit", groups.digit, "7"], ["requireSymbol", groups.symbol, "!"]
      ].filter(([flag, group]) => policy[flag] && ![...(head + site + tail)].some((char) => group.includes(char)))
        .map(([, , fallback]) => fallback).join("");
      while (head.length + site.length + tail.length + missing().length > maximum && tail.length > 1) tail = tail.slice(1);
      let result = head + site + tail + missing();
      if (result.length > maximum) throw new Error("网站允许的长度不足以生成易记建议");
      const target = Math.min(maximum, Math.max(minimum, 16));
      const filler = site + source.slice(4, -4) + site;
      let offset = 0;
      while (result.length < target) result += filler[offset++ % filler.length];
      return result;
    }
    const suffix = [];
    for (const [flag, group] of [
      ["requireUpper", groups.upper], ["requireLower", groups.lower],
      ["requireDigit", groups.digit], ["requireSymbol", groups.symbol]
    ]) {
      if (policy[flag]) {
        suffix.push(group[randomIndex(group.length)]);
      }
    }
    while (suffix.length < length) suffix.push(alphabet[randomIndex(alphabet.length)]);
    for (let index = suffix.length - 1; index > 0; index--) {
      const swap = randomIndex(index + 1);
      [suffix[index], suffix[swap]] = [suffix[swap], suffix[index]];
    }
    return suffix.join("");
  }

  function normalizeHost(value) {
    let input = String(value || "").trim().toLowerCase();
    if (!input) return "";
    try {
      if (!input.includes("://")) input = `https://${input}`;
      return new URL(input).hostname.replace(/^www\./, "");
    } catch {
      return input.replace(/^https?:\/\//, "").split("/")[0].replace(/^www\./, "");
    }
  }

  globalThis.PasswordCrypto = {
    ITERATIONS,
    createRecord,
    createRecoveryRecord,
    decryptWithKey,
    deriveKey,
    encryptWithKey,
    exportKey,
    generatePassword,
    suggestedPassword,
    importKey,
    normalizeHost,
    openRecord,
    openRecoveryRecord,
    prfKey
  };
})();
