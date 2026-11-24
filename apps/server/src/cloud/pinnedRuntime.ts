// V3 Code permanently disables remote CLI runtime downloads.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { HttpClient } from "effect/http";

import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as ProcessRunner from "../processRunner.ts";

const PINNED_RUNTIME_DIR = "runtime";
const PINNED_RUNTIME_LAUNCHERS_FILE = "launchers";

export interface PinnedRuntimePaths {
  readonly versionDir: string;
  readonly entryPath: string;
  readonly sentinelPath: string;
}

export function pinnedRuntimeCommand(paths: PinnedRuntimePaths): {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
} {
  return { command: paths.entryPath, args: [] };
}

export function pinnedRuntimeVersionsDir(path: Path.Path, baseDir: string): string {
  return path.join(baseDir, PINNED_RUNTIME_DIR, "versions");
}

export function pinnedRuntimePaths(
  path: Path.Path,
  baseDir: string,
  version: string,
  platform: NodeJS.Platform,
): PinnedRuntimePaths {
  const versionDir = path.join(pinnedRuntimeVersionsDir(path, baseDir), version);
  return {
    versionDir,
    entryPath: path.join(versionDir, platform === "win32" ? "v3.exe" : "v3"),
    sentinelPath: path.join(versionDir, ".install-complete"),
  };
}

export class PinnedRuntimeInstallError extends Schema.TaggedError<PinnedRuntimeInstallError>()(
  "PinnedRuntimeInstallError",
  {
    step: Schema.String,
    exitCode: Schema.optional(Schema.Number),
    stdoutLength: Schema.optional(Schema.Number),
    stderrLength: Schema.optional(Schema.Number),
    httpStatus: Schema.optional(Schema.Number),
    downloadHost: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.exitCode === undefined
      ? `Pinned runtime install failed while ${this.step}.`
      : `Pinned runtime install failed while ${this.step} (exit code ${this.exitCode}).`;
  }
}

export class PinnedRuntimePreflightBlockedError extends Schema.TaggedError<PinnedRuntimePreflightBlockedError>()(
  "PinnedRuntimePreflightBlockedError",
  {
    version: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export type PinnedRuntimeProgress =
  | { readonly stage: "download"; readonly received: number; readonly total: number | undefined }
  | { readonly stage: "verify" | "extract" | "validate" | "cached" };

interface PinnedRuntimeInstallInput {
  readonly baseDir: string;
  readonly version: string;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly runner: ProcessRunner.ProcessRunner["Service"];
  readonly validate: (
    paths: PinnedRuntimePaths,
  ) => Effect.Effect<void, PinnedRuntimeInstallError | PinnedRuntimePreflightBlockedError>;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly httpClient: HttpClient.HttpClient;
  readonly releaseBaseUrl?: string | undefined;
  readonly requirePublishedRelease?: boolean;
  readonly onProgress?: (progress: PinnedRuntimeProgress) => void;
}

export const isUnpublishedRelease = (_error: unknown): _error is PinnedRuntimeInstallError => false;

export const ensurePinnedRuntimeInstalled = (
  _input: PinnedRuntimeInstallInput,
): Effect.Effect<
  PinnedRuntimePaths,
  PinnedRuntimeInstallError | PinnedRuntimePreflightBlockedError
> =>
  Effect.fail(
    new PinnedRuntimeInstallError({
      step: "disabled in V3 Code (automatic runtime downloads are disabled)",
    }),
  );

export function launcherOwnsVersionsDir(
  path: Path.Path,
  versionsDir: string,
  candidate: string,
): boolean {
  const relative = path.relative(versionsDir, path.resolve(candidate));
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export const resolveLauncherPath = Effect.gen(function* () {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const invokedAs = yield* HostProcess.InvokedAs;
  const cwd = yield* HostProcess.WorkingDirectory;
  const environment = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  if (invokedAs.includes("/") || invokedAs.includes("\\")) {
    return path.resolve(cwd, invokedAs);
  }
  const delimiter = platform === "win32" ? ";" : ":";
  const searchPath = environment["PATH"] ?? "";
  for (const directory of searchPath.split(delimiter)) {
    if (directory.length === 0 && (platform === "win32" || searchPath.length === 0)) continue;
    const candidate = path.resolve(cwd, directory || ".", invokedAs);
    const info = yield* fs.stat(candidate).pipe(Effect.option);
    if (
      Option.isSome(info) &&
      info.value.type === "File" &&
      (platform === "win32" || (info.value.mode & 0o111) !== 0)
    ) {
      return candidate;
    }
  }
  return undefined;
});

const launcherRecords = (launchers: ReadonlyArray<string>) =>
  `\n${launchers.map((launcher) => `${launcher}\n`).join("")}`;

export const recordPinnedRuntimeLauncher = Effect.fn("cloud.pinned_runtime.record_launcher")(
  function* (input: { readonly baseDir: string; readonly launcher: string }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const launchersFile = path.join(
      input.baseDir,
      PINNED_RUNTIME_DIR,
      PINNED_RUNTIME_LAUNCHERS_FILE,
    );
    const launcher = path.resolve(input.launcher);
    const recorded = yield* fs.readFileString(launchersFile).pipe(Effect.orElseSucceed(() => ""));
    if (recorded.split(/\r?\n/).includes(launcher)) return;
    yield* fs.writeFileString(launchersFile, launcherRecords([launcher]), { flag: "a" });
  },
);

export function isVersionExecutable(
  path: Path.Path,
  versionsDir: string,
  candidate: string,
): boolean {
  const relative = path.relative(versionsDir, path.resolve(candidate));
  return !path.isAbsolute(relative) && /^(?!\.\.)[^\\/]+[\\/]v3(?:\.exe)?$/i.test(relative);
}

export const windowsShimTarget = (contents: string) => /^"([^"]+)"/m.exec(contents)?.[1];

export const generatedWindowsShimTarget = (contents: string) =>
  /^@echo off\r?\n"([^"]+)" %\*\s*$/.exec(contents)?.[1];

export const posixLauncherScript = (executable: string) =>
  `#!/bin/sh\nexec '${executable.replaceAll("'", "'\\''")}' "$@"\n`;

export const readPosixLauncherTarget = Effect.fn("cloud.pinned_runtime.read_posix_launcher")(
  function* (launcher: string) {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(launcher).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "File" || info.value.size > 4096n) {
      return undefined;
    }
    const contents = yield* fs.readFileString(launcher).pipe(Effect.option);
    if (Option.isNone(contents)) return undefined;
    const quoted = /^#!\/bin\/sh\nexec '((?:[^']|'\\'')*)' "\$@"\n$/.exec(contents.value)?.[1];
    return quoted?.replaceAll("'\\''", "'");
  },
);

export const findPosixLauncher = Effect.fn("cloud.pinned_runtime.find_posix_launcher")(
  function* (_input: { readonly launchedAs: string; readonly versionsDir: string }) {
    return undefined as string | undefined;
  },
);

export const writePosixLauncher = Effect.fn("cloud.pinned_runtime.write_posix_launcher")(
  function* (input: {
    readonly launcher: string;
    readonly executable: string;
    readonly exclusive: boolean;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const staging = yield* fs.makeTempFileScoped({
      directory: path.dirname(input.launcher),
      prefix: ".v3-",
    });
    yield* fs.writeFileString(staging, posixLauncherScript(input.executable));
    yield* fs.chmod(staging, 0o755);
    yield* input.exclusive ? fs.link(staging, input.launcher) : fs.rename(staging, input.launcher);
  },
  Effect.scoped,
);

export const prunePinnedRuntimes = Effect.fn("cloud.pinned_runtime.prune")(function* (_input: {
  readonly baseDir: string;
  readonly keep: ReadonlyArray<string>;
  readonly references?: ReadonlyArray<string>;
}) {
  return [] as Array<string>;
});
