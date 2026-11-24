// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";
import {
  createEphemeralBaseDir,
  EPHEMERAL_DIR_PREFIX,
  secureWipeEphemeralDirectory,
} from "./privacyWipe.ts";

describe("privacyWipe", () => {
  it("creates an ephemeral directory and securely wipes its contents", () => {
    const tmpRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "v3-wipe-test-"));
    try {
      const created = createEphemeralBaseDir({
        platform: "darwin",
        tmpDir: tmpRoot,
      });
      expect(created.storage).toBe("tmp");
      expect(NodePath.basename(created.baseDir).startsWith(EPHEMERAL_DIR_PREFIX)).toBe(true);

      const secretFile = NodePath.join(created.baseDir, "userdata", "secrets", "key");
      NodeFS.mkdirSync(NodePath.dirname(secretFile), { recursive: true });
      NodeFS.writeFileSync(secretFile, "super-secret-material-12345");
      expect(NodeFS.existsSync(secretFile)).toBe(true);

      expect(secureWipeEphemeralDirectory(created.baseDir)).toBe(true);
      expect(NodeFS.existsSync(created.baseDir)).toBe(false);
    } finally {
      NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("refuses to wipe non-ghost directories", () => {
    const tmpRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "v3-non-ghost-"));
    try {
      const sentinel = NodePath.join(tmpRoot, "keep.txt");
      NodeFS.writeFileSync(sentinel, "must-remain");

      expect(secureWipeEphemeralDirectory(tmpRoot)).toBe(false);
      expect(NodeFS.readFileSync(sentinel, "utf8")).toBe("must-remain");
    } finally {
      NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
