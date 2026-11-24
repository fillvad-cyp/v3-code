// @effect-diagnostics nodeBuiltinImport:off - secure wipe runs synchronously inside process exit and Effect finalizers where async FileSystem is unavailable.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { EphemeralStorageKind } from "@t3tools/shared/privacyShield";

export const EPHEMERAL_DIR_PREFIX = "v3-ghost-";

const ZERO_CHUNK = Buffer.alloc(64 * 1024, 0);

function isWritableDirectory(dirPath: string): boolean {
  try {
    const stat = NodeFS.statSync(dirPath);
    if (!stat.isDirectory()) return false;
    NodeFS.accessSync(dirPath, NodeFS.constants.W_OK | NodeFS.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Allocates an owner-only (0700) ephemeral Ghost directory, preferring RAM-backed `/dev/shm`
 * on Linux so database, secrets, and caches never touch physical disk.
 */
export function createEphemeralBaseDir(options: {
  readonly platform: NodeJS.Platform;
  readonly shmDir?: string;
  readonly tmpDir?: string;
}): { readonly baseDir: string; readonly storage: EphemeralStorageKind } {
  const platform = options.platform;
  const shmDir = options.shmDir ?? "/dev/shm";
  const tmpDir = options.tmpDir ?? NodeOS.tmpdir();

  const useRamShm = platform === "linux" && isWritableDirectory(shmDir);
  const parentDir = useRamShm ? shmDir : tmpDir;
  const baseDir = NodeFS.mkdtempSync(NodePath.join(parentDir, EPHEMERAL_DIR_PREFIX));
  try {
    NodeFS.chmodSync(baseDir, 0o700);
  } catch {
    // Windows ACLs do not support POSIX chmod bits.
  }
  return { baseDir, storage: useRamShm ? "ram" : "tmp" };
}

function overwriteRegularFileWithZeros(filePath: string): void {
  let fd: number | undefined;
  try {
    const stat = NodeFS.lstatSync(filePath);
    if (!stat.isFile() || stat.size <= 0) return;
    try {
      NodeFS.chmodSync(filePath, 0o600);
    } catch {
      // Best-effort make read-only files (e.g. git objects or 0400 secrets) writable before overwrite.
    }
    fd = NodeFS.openSync(filePath, "r+");
    let remaining = stat.size;
    let offset = 0;
    while (remaining > 0) {
      const toWrite = Math.min(remaining, ZERO_CHUNK.byteLength);
      const written = NodeFS.writeSync(fd, ZERO_CHUNK, 0, toWrite, offset);
      if (written <= 0) break;
      remaining -= written;
      offset += written;
    }
    try {
      NodeFS.fsyncSync(fd);
    } catch {
      // tmpfs / RAM disks may not require or support fsync.
    }
  } catch {
    // Best-effort overwrite before unlink.
  } finally {
    if (fd !== undefined) {
      try {
        NodeFS.closeSync(fd);
      } catch {}
    }
  }
}

function walkAndOverwriteFiles(dirPath: string): void {
  try {
    NodeFS.chmodSync(dirPath, 0o700);
  } catch {}
  let entries: ReadonlyArray<NodeFS.Dirent>;
  try {
    entries = NodeFS.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = NodePath.join(dirPath, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      walkAndOverwriteFiles(fullPath);
    } else if (entry.isFile()) {
      overwriteRegularFileWithZeros(fullPath);
    }
  }
}

/**
 * Overwrites regular files inside a V3 Ghost ephemeral directory with zero bytes
 * and deletes the directory tree. Refuses any directory not prefixed with `v3-ghost-`.
 */
export function secureWipeEphemeralDirectory(dirPath: string): boolean {
  const resolved = NodePath.resolve(dirPath);
  if (!NodePath.basename(resolved).startsWith(EPHEMERAL_DIR_PREFIX)) {
    return false;
  }
  if (!NodeFS.existsSync(resolved)) {
    return true;
  }
  walkAndOverwriteFiles(resolved);
  try {
    NodeFS.rmSync(resolved, { recursive: true, force: true });
    return !NodeFS.existsSync(resolved);
  } catch {
    return false;
  }
}
