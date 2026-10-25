const format = "retirement-planner.encrypted-scenario";
const iterations = 600_000;

type EncryptedScenario = {
  format: typeof format;
  version: 1;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  cipher: "AES-GCM";
  salt: string;
  iv: string;
  ciphertext: string;
};

function encodeBase64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function getCrypto(): Crypto {
  if (!globalThis.crypto?.subtle) throw new Error("Password protection requires HTTPS or localhost in a browser with Web Crypto support.");
  return globalThis.crypto;
}

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>, keyIterations: number): Promise<CryptoKey> {
  const crypto = getCrypto();
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: keyIterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export function isEncryptedScenario(value: unknown): boolean {
  return typeof value === "object" && value !== null && "format" in value && value.format === format;
}

export async function encryptScenario(plaintext: string, password: string): Promise<string> {
  if (!password) throw new Error("Enter a password.");
  const crypto = getCrypto();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, iterations);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  const envelope: EncryptedScenario = {
    format,
    version: 1,
    kdf: "PBKDF2-SHA256",
    iterations,
    cipher: "AES-GCM",
    salt: encodeBase64(salt),
    iv: encodeBase64(iv),
    ciphertext: encodeBase64(new Uint8Array(ciphertext)),
  };
  return JSON.stringify(envelope, null, 2);
}

export async function decryptScenario(value: unknown, password: string): Promise<string> {
  getCrypto();
  if (!isEncryptedScenario(value)) throw new Error("Not an encrypted scenario file.");
  const envelope = value as Partial<EncryptedScenario>;
  if (envelope.version !== 1 || envelope.kdf !== "PBKDF2-SHA256" || envelope.cipher !== "AES-GCM"
    || !Number.isInteger(envelope.iterations) || envelope.iterations !== iterations
    || typeof envelope.salt !== "string" || typeof envelope.iv !== "string" || typeof envelope.ciphertext !== "string") {
    throw new Error("Unsupported or damaged encrypted scenario file.");
  }
  if (!password) throw new Error("Enter a password.");
  try {
    const salt = decodeBase64(envelope.salt);
    const iv = decodeBase64(envelope.iv);
    const ciphertext = decodeBase64(envelope.ciphertext);
    if (salt.length !== 16 || iv.length !== 12 || ciphertext.length < 16) throw new Error("Invalid encrypted data.");
    const key = await deriveKey(password, salt, envelope.iterations);
    const plaintext = await getCrypto().subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  } catch {
    throw new Error("Unable to open the scenario. The password is incorrect or the file is damaged.");
  }
}