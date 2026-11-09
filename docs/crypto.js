"use strict";
// research/crypto.py と同じ方式（PBKDF2-SHA256 → AES-256-GCM）

const Crypto = (() => {
  const ITER = 250000;
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const keyCache = new Map();

  const b64 = (buf) => {
    let s = "";
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  async function key(password, salt, iter) {
    const id = `${password}\u0000${b64(salt)}\u0000${iter}`;
    if (keyCache.has(id)) return keyCache.get(id);
    const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
    const k = await crypto.subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations: iter },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    keyCache.set(id, k);
    return k;
  }

  async function encrypt(obj, password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const k = await key(password, salt, ITER);
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, enc.encode(JSON.stringify(obj)));
    return { v: 1, kdf: "pbkdf2-sha256", iter: ITER, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
  }

  async function decrypt(env, password) {
    try {
      const k = await key(password, unb64(env.salt), env.iter || ITER);
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(env.iv) }, k, unb64(env.ct));
      return JSON.parse(dec.decode(pt));
    } catch (e) {
      const err = new Error("パスワードが違います");
      err.wrongPassword = true;
      throw err;
    }
  }

  // UTF-8 文字列 ⇔ base64（GitHub contents API 用）
  const strToB64 = (s) => b64(enc.encode(s));
  const b64ToStr = (s) => dec.decode(unb64(s.replace(/\n/g, "")));

  return { encrypt, decrypt, strToB64, b64ToStr };
})();
