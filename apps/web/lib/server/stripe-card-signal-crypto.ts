import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export function encryptPaymentMethodId(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptPaymentMethodId(value: string, key: Buffer): string {
  const [version, iv, tag, ciphertext] = value.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext)
    throw new Error("invalid_payment_method_ciphertext");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function localWebhookSignature(
  rawBody: string,
  secret: string,
  timestamp = Math.floor(Date.now() / 1000),
) {
  const digest = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

export function verifyLocalWebhookSignature(
  rawBody: string,
  signature: string,
  secret: string,
  now = Date.now(),
) {
  const values = Object.fromEntries(
    signature.split(",").map((item) => item.split("=", 2)),
  );
  const timestamp = Number(values.t);
  const supplied = values.v1;
  if (!Number.isInteger(timestamp) || !supplied || supplied.length !== 64)
    throw new Error("stripe_signature_invalid");
  if (Math.abs(now / 1000 - timestamp) > 300)
    throw new Error("stripe_signature_expired");
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  if (
    !timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(expected, "hex"))
  ) {
    throw new Error("stripe_signature_invalid");
  }
}
