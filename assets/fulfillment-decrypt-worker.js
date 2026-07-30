"use strict";

const keyCache = new Map();

function bytesFromBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function deriveKey(password, salt, iterations) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
}

async function decryptMessage(message) {
  const timings = { encryptedParseMs: 0, deriveMs: 0, decryptMs: 0, decompressMs: 0, dataParseMs: 0 };
  let started = performance.now();
  const payload = JSON.parse(message.payloadText);
  timings.encryptedParseMs = performance.now() - started;
  if (payload.version !== 1 || payload.algorithm !== "AES-256-GCM") {
    throw new Error("加密数据格式不受支持");
  }

  const keyId = payload.kdf.salt;
  let key = keyCache.get(keyId);
  if (!key) {
    postMessage({ type: "progress", id: message.id, stage: "derive" });
    started = performance.now();
    key = await deriveKey(
      message.password,
      bytesFromBase64(keyId),
      Number(payload.kdf.iterations),
    );
    timings.deriveMs = performance.now() - started;
    keyCache.set(keyId, key);
  }

  postMessage({ type: "progress", id: message.id, stage: "decrypt" });
  started = performance.now();
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytesFromBase64(payload.iv) },
    key,
    bytesFromBase64(payload.ciphertext),
  );
  timings.decryptMs = performance.now() - started;

  if (!("DecompressionStream" in self)) {
    throw new Error("浏览器版本过旧，请升级Chrome或Edge");
  }
  postMessage({ type: "progress", id: message.id, stage: "decompress" });
  started = performance.now();
  const stream = new Blob([plaintext]).stream().pipeThrough(
    new DecompressionStream("gzip"),
  );
  const decompressed = await new Response(stream).arrayBuffer();
  timings.decompressMs = performance.now() - started;

  postMessage({ type: "progress", id: message.id, stage: "parse" });
  started = performance.now();
  const result = JSON.parse(new TextDecoder().decode(decompressed));
  timings.dataParseMs = performance.now() - started;
  return { result, timings };
}

self.addEventListener("message", async (event) => {
  const message = event.data || {};
  if (message.type === "clear") {
    keyCache.clear();
    postMessage({ type: "cleared", id: message.id });
    return;
  }
  if (message.type !== "decrypt") return;
  try {
    const output = await decryptMessage(message);
    postMessage({ type: "result", id: message.id, ...output });
  } catch (error) {
    postMessage({
      type: "error",
      id: message.id,
      name: error?.name || "Error",
      message: error?.message || "解密失败",
    });
  }
});
