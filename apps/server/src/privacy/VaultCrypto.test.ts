import { describe, expect, it } from "vite-plus/test";

import { decryptVaultJson, encryptVaultJson, isEncryptedVaultEnvelope } from "./VaultCrypto.ts";

describe("VaultCrypto", () => {
  it("encrypts and decrypts vault payloads with AES-256-GCM + PBKDF2-SHA256", () => {
    const payload = JSON.stringify({
      version: 1,
      proxies: [{ url: "socks5h://user:pass@127.0.0.1:9050" }],
    });
    const envelope = encryptVaultJson(payload, "hunter2-master-pass");

    expect(isEncryptedVaultEnvelope(envelope)).toBe(true);
    expect(JSON.stringify(envelope)).not.toContain("socks5h");
    expect(JSON.stringify(envelope)).not.toContain("hunter2");

    expect(decryptVaultJson(envelope, "wrong-pass")).toBeNull();
    expect(decryptVaultJson(envelope, "hunter2-master-pass")).toBe(payload);

    // Tampered ciphertext must fail GCM authentication.
    const tampered = {
      ...envelope,
      ciphertext: Buffer.from("tampered-data").toString("base64"),
    };
    expect(decryptVaultJson(tampered, "hunter2-master-pass")).toBeNull();
  });
});
