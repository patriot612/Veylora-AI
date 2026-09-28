const IV_BYTES = 12;
const KEY_BYTES = 32;
const VERSION_PREFIX = "v1";

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const raw = atob(normalized);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

function encodeBase64Url(value: Uint8Array): string {
  let raw = "";
  for (const byte of value) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function deriveKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest.slice(0, KEY_BYTES), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptCredentialSecret(secret: string, encryptionKey: string): Promise<string> {
  if (!secret) throw new Error("credential_secret_empty");
  if (!encryptionKey) throw new Error("credential_encryption_key_missing");
  const key = await deriveKey(encryptionKey);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(secret)));
  return [VERSION_PREFIX, encodeBase64Url(iv), encodeBase64Url(ciphertext)].join(".");
}

export async function decryptCredentialSecret(ciphertext: string, encryptionKey: string): Promise<string> {
  if (!ciphertext || !encryptionKey) throw new Error("credential_secret_unavailable");
  const [version, encodedIv, encodedCiphertext] = ciphertext.split(".");
  if (version !== VERSION_PREFIX || !encodedIv || !encodedCiphertext) throw new Error("credential_ciphertext_invalid");
  const key = await deriveKey(encryptionKey);
  try {
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decodeBase64Url(encodedIv) }, key, decodeBase64Url(encodedCiphertext));
    return new TextDecoder().decode(plaintext);
  } catch (error) {
    throw new Error("credential_decryption_failed", { cause: error });
  }
}