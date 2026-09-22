import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hmacHex(secret: string, ...parts: string[]): string {
  return createHmac("sha256", secret).update(parts.join("\0")).digest("hex");
}

export function deriveCapability(secret: string, ...parts: string[]): string {
  return createHmac("sha256", secret).update(parts.join("\0")).digest("base64url");
}

export function randomCapability(): string {
  return randomBytes(32).toString("base64url");
}

export function encryptSensitiveValue(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export function decryptSensitiveValue(value: string, key: Buffer): string {
  const [version, iv, tag, ciphertext] = value.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext)
    throw new Error("invalid_sensitive_ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export const encryptEmail = encryptSensitiveValue;
export const decryptEmail = decryptSensitiveValue;

export function normalizeEmail(email: string): string {
  return email.trim().normalize("NFKC").toLowerCase();
}
