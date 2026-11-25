// @effect-diagnostics nodeBuiltinImport:off -- Uses Node crypto directly for synchronous AES-256-GCM vault sealing.
import * as NodeCrypto from "node:crypto";

const VAULT_ENVELOPE_VERSION = 1;
const PBKDF2_ITERATIONS = 310_000;
const KEY_LENGTH_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;

export interface EncryptedVaultEnvelope {
  readonly version: 1;
  readonly encrypted: true;
  readonly kdf: "pbkdf2-sha256";
  readonly iterations: number;
  readonly salt: string;
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

export function isEncryptedVaultEnvelope(value: unknown): value is EncryptedVaultEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === VAULT_ENVELOPE_VERSION &&
    candidate.encrypted === true &&
    candidate.kdf === "pbkdf2-sha256" &&
    typeof candidate.iterations === "number" &&
    typeof candidate.salt === "string" &&
    typeof candidate.iv === "string" &&
    typeof candidate.tag === "string" &&
    typeof candidate.ciphertext === "string"
  );
}

function deriveVaultKey(passphrase: string, salt: Buffer, iterations: number): Buffer {
  return NodeCrypto.pbkdf2Sync(passphrase, salt, iterations, KEY_LENGTH_BYTES, "sha256");
}

export function encryptVaultJson(
  plaintextJson: string,
  passphrase: string,
): EncryptedVaultEnvelope {
  const salt = NodeCrypto.randomBytes(SALT_BYTES);
  const iv = NodeCrypto.randomBytes(IV_BYTES);
  const key = deriveVaultKey(passphrase, salt, PBKDF2_ITERATIONS);
  try {
    const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintextJson, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      version: VAULT_ENVELOPE_VERSION,
      encrypted: true,
      kdf: "pbkdf2-sha256",
      iterations: PBKDF2_ITERATIONS,
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
  } finally {
    key.fill(0);
  }
}

export function decryptVaultJson(
  envelope: EncryptedVaultEnvelope,
  passphrase: string,
): string | null {
  if (
    !Number.isInteger(envelope.iterations) ||
    envelope.iterations < 100_000 ||
    envelope.iterations > 2_000_000
  ) {
    return null;
  }
  const salt = Buffer.from(envelope.salt, "base64");
  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");
  if (salt.length < 8 || iv.length !== IV_BYTES || tag.length !== 16) {
    return null;
  }

  const key = deriveVaultKey(passphrase, salt, envelope.iterations);
  try {
    const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  } catch {
    return null;
  } finally {
    key.fill(0);
  }
}
