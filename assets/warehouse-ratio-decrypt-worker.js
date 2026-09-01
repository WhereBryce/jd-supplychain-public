"use strict";

const keyCache = new Map();
const bytes = (value) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

async function decrypt(message) {
  const payload = JSON.parse(message.payloadText);
  if (
    payload.version !== 1 ||
    payload.algorithm !== "AES-256-GCM" ||
    payload.compression !== "gzip" ||
    payload.kdf?.hash !== "SHA-256" ||
    Number(payload.kdf?.iterations) !== 600000
  ) {
    throw new Error("加密数据格式不受支持");
  }

  let key = keyCache.get(payload.kdf.salt);
  if (!key) {
    postMessage({ type: "progress", id: message.id, stage: "derive" });
    const material = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(message.password),
      "PBKDF2",
      false,
      ["deriveKey"]
    );
    key = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: bytes(payload.kdf.salt),
        iterations: 600000,
        hash: "SHA-256",
      },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"]
    );
  }

  postMessage({ type: "progress", id: message.id, stage: "decrypt" });
  const compressed = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes(payload.iv) },
    key,
    bytes(payload.ciphertext)
  );
  keyCache.set(payload.kdf.salt, key);
  if (!("DecompressionStream" in self)) {
    throw new Error("浏览器版本过旧，请升级 Chrome 或 Edge");
  }
  postMessage({ type: "progress", id: message.id, stage: "decompress" });
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"));
  postMessage({ type: "progress", id: message.id, stage: "parse" });
  return JSON.parse(new TextDecoder().decode(await new Response(stream).arrayBuffer()));
}

self.addEventListener("message", async ({ data: message }) => {
  if (message?.type === "clear") {
    keyCache.clear();
    return;
  }
  if (message?.type !== "decrypt") return;
  try {
    postMessage({ type: "result", id: message.id, result: await decrypt(message) });
  } catch (error) {
    postMessage({
      type: "error",
      id: message.id,
      name: error?.name || "Error",
      message: error?.message || "解密失败",
    });
  }
});
