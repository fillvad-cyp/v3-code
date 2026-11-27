// @effect-diagnostics nodeBuiltinImport:off -- sync SHA-256 slug derivation and OS user identity lookup avoid effectful boilerplate in pure helpers.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import {
  AuthSessionId,
  PositiveInt,
  PROJECT_GIT_HTTP_TOKEN_SECRET_NAME,
  PROJECT_GIT_HTTP_USERNAME_SECRET_NAME,
  PROJECT_GIT_SSH_KEY_SECRET_NAME,
  PROJECT_GIT_SSH_KNOWN_HOSTS_SECRET_NAME,
  ProjectId,
  type ProjectIsolationLevel,
  type ProjectIsolationRecord,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type * as ProjectAccess from "../access/ProjectAccess.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectIsolationRepo from "../persistence/ProjectIsolationRepo.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectSecrets from "../project/ProjectSecrets.ts";
import { isWithinRoot } from "../workspace/KnownWorkspaces.ts";

export const DEFAULT_ISOLATION_PORT_RANGE_BASE = 20_000;
export const DEFAULT_ISOLATION_PORT_RANGE_SIZE = 100;
export const DEFAULT_ISOLATION_PORT_RANGE_MAX = 60_000;
export const DEFAULT_SERVICE_HOME_BASE = "/home";
const DEFAULT_ISOLATED_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const DEFAULT_ISOLATED_LANG = "C.UTF-8";
const DEFAULT_ISOLATED_TERM = "xterm-256color";
const DEFAULT_GIT_HTTP_USERNAME = "x-access-token";
const OS_COMMAND_TIMEOUT = "15 seconds";

const SYSTEM_GIT_ISOLATION_ACTOR: ProjectAccess.AccessActor = {
  sessionId: AuthSessionId.make("system:git-isolation"),
  subject: "system:git-isolation",
  scopes: [],
  binding: { _tag: "environment" },
  isOwner: true,
  roles: new Map(),
};

export interface ProjectIsolationSettings {
  readonly portRangeBase: number;
  readonly portRangeSize: number;
  readonly portRangeMax: number;
  readonly serviceHomeBase: string;
  /** Override for testing privilege detection (`0` means root without sudo). */
  readonly currentUid?: number | undefined;
  /** Override for testing server OS user added/removed from project groups. */
  readonly currentUsername?: string | null | undefined;
}

export const ProjectIsolationConfig = Context.Reference<ProjectIsolationSettings>(
  "v3code/isolation/ProjectIsolationConfig",
  {
    defaultValue: () => ({
      portRangeBase: DEFAULT_ISOLATION_PORT_RANGE_BASE,
      portRangeSize: DEFAULT_ISOLATION_PORT_RANGE_SIZE,
      portRangeMax: DEFAULT_ISOLATION_PORT_RANGE_MAX,
      serviceHomeBase: DEFAULT_SERVICE_HOME_BASE,
    }),
  },
);

export class ProjectIsolationNotFoundError extends Schema.TaggedError<ProjectIsolationNotFoundError>()(
  "ProjectIsolationNotFoundError",
  {
    projectId: ProjectId,
  },
) {
  override get message(): string {
    return `Project ${this.projectId} was not found.`;
  }
}

export class ProjectIsolationPortExhaustedError extends Schema.TaggedError<ProjectIsolationPortExhaustedError>()(
  "ProjectIsolationPortExhaustedError",
  {
    projectId: ProjectId,
    base: Schema.Number,
    max: Schema.Number,
    blockSize: Schema.Number,
  },
) {
  override get message(): string {
    return `No free isolation port block (${this.blockSize} ports in ${this.base}-${this.max}) is available for project ${this.projectId}.`;
  }
}

export class ProjectIsolationCommandError extends Schema.TaggedError<ProjectIsolationCommandError>()(
  "ProjectIsolationCommandError",
  {
    projectId: ProjectId,
    stage: Schema.String,
    command: Schema.String,
    exitCode: Schema.NullOr(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const codeText = this.exitCode === null ? "no exit code" : `exit code ${this.exitCode}`;
    return `Project isolation step '${this.stage}' failed running '${this.command}' (${codeText}).`;
  }
}

export class ProjectIsolationVerificationError extends Schema.TaggedError<ProjectIsolationVerificationError>()(
  "ProjectIsolationVerificationError",
  {
    projectId: ProjectId,
    stage: Schema.String,
    expected: Schema.String,
    observed: Schema.String,
  },
) {
  override get message(): string {
    return `Project isolation verification failed at '${this.stage}' (expected ${this.expected}, observed ${this.observed}).`;
  }
}

export class ProjectIsolationPersistenceError extends Schema.TaggedError<ProjectIsolationPersistenceError>()(
  "ProjectIsolationPersistenceError",
  {
    operation: Schema.String,
    projectId: Schema.optional(ProjectId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Project isolation persistence failed during '${this.operation}'.`;
  }
}

export type ProjectIsolationError =
  | ProjectIsolationNotFoundError
  | ProjectIsolationPortExhaustedError
  | ProjectIsolationCommandError
  | ProjectIsolationVerificationError
  | ProjectIsolationPersistenceError;

export interface ProjectIsolationTransitionResult {
  readonly record: ProjectIsolationRecord;
  readonly effectiveLevel: ProjectIsolationLevel;
  readonly fellBackToL0: boolean;
  readonly fallbackReason: string | null;
}

export interface ProjectIsolationRuntimeContext {
  readonly projectId: ProjectId;
  readonly level: 1;
  readonly serviceUser: string;
  readonly serviceGroup: string;
  readonly serviceHome: string;
  readonly workspaceRoot: string;
  readonly worktreesDir: string;
  readonly stateDir: string;
  readonly portsFrom: number | null;
  readonly portsTo: number | null;
  readonly useSudo: boolean;
}

export interface PortRange {
  readonly portsFrom: number;
  readonly portsTo: number;
}

export interface PasswdEntry {
  readonly username: string;
  readonly uid: number;
  readonly gid: number;
  readonly homeDir: string;
  readonly shell: string;
}

export interface GroupEntry {
  readonly groupName: string;
  readonly gid: number;
  readonly members: ReadonlyArray<string>;
}

export interface StatOwnerMode {
  readonly owner: string;
  readonly group: string;
  readonly modeOctal: string;
}

/**
 * Derive a deterministic, Linux-safe slug (max 24 chars, `[a-z0-9-]`) from project id and title.
 * Both `svc-<slug>` (<= 28 chars) and `t3-<slug>` (<= 27 chars) fit Linux's 32-char username limit.
 */
export function deriveIsolationSlug(input: {
  readonly projectId: string;
  readonly title?: string | null;
}): string {
  const hash = NodeCrypto.createHash("sha256")
    .update(input.projectId, "utf8")
    .digest("hex")
    .slice(0, 6);
  const rawBase = (input.title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 17)
    .replace(/-+$/g, "");
  return rawBase.length > 0 ? `${rawBase}-${hash}` : `p-${hash}`;
}

export function deriveServiceUser(slug: string): string {
  return `svc-${slug}`;
}

export function deriveServiceGroup(slug: string): string {
  return `t3-${slug}`;
}

function projectIsolatedStateDir(stateDir: string, projectId: string): string {
  return `${stateDir.replace(/\/+$/g, "")}/projects/${projectId}`;
}

function projectIsolatedWorktreesDir(worktreesDir: string, projectId: string): string {
  return `${worktreesDir.replace(/\/+$/g, "")}/${projectId}`;
}

export function allocatePortRange(
  existingRanges: ReadonlyArray<PortRange>,
  options?: {
    readonly base?: number;
    readonly size?: number;
    readonly max?: number;
  },
): PortRange | null {
  const base = Math.max(1024, Math.floor(options?.base ?? DEFAULT_ISOLATION_PORT_RANGE_BASE));
  const size = Math.max(1, Math.floor(options?.size ?? DEFAULT_ISOLATION_PORT_RANGE_SIZE));
  const max = Math.min(65_535, Math.floor(options?.max ?? DEFAULT_ISOLATION_PORT_RANGE_MAX));
  if (base + size - 1 > max) {
    return null;
  }

  for (let start = base; start + size - 1 <= max; start += size) {
    const end = start + size - 1;
    const overlaps = existingRanges.some(
      (range) => start <= range.portsTo && end >= range.portsFrom,
    );
    if (!overlaps) {
      return { portsFrom: start, portsTo: end };
    }
  }
  return null;
}

/**
 * Strictly allowlisted environment for L1 terminals. Host secrets and ambient variables are
 * omitted rather than blocklisted.
 */
export function buildIsolatedTerminalEnv(input: {
  readonly serviceUser: string;
  readonly serviceHome?: string | undefined;
  readonly projectId: string;
  readonly memberId?: string | null | undefined;
  readonly baseEnv: NodeJS.ProcessEnv;
}): Record<string, string> {
  const pathValue = input.baseEnv.PATH?.trim();
  const langValue = input.baseEnv.LANG?.trim();
  const termValue = input.baseEnv.TERM?.trim();
  const home = input.serviceHome?.trim() || `${DEFAULT_SERVICE_HOME_BASE}/${input.serviceUser}`;

  const env: Record<string, string> = {
    PATH: pathValue && pathValue.length > 0 ? pathValue : DEFAULT_ISOLATED_PATH,
    HOME: home,
    T3_PROJECT_ID: input.projectId,
    LANG: langValue && langValue.length > 0 ? langValue : DEFAULT_ISOLATED_LANG,
    TERM: termValue && termValue.length > 0 ? termValue : DEFAULT_ISOLATED_TERM,
  };
  const trimmedMemberId = input.memberId?.trim();
  if (trimmedMemberId && trimmedMemberId.length > 0) {
    env.T3_MEMBER_ID = trimmedMemberId;
  }
  return env;
}

export function buildSystemdRunCommand(input: {
  readonly serviceUser: string;
  readonly serviceGroup: string;
  readonly cwd: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly useSudo?: boolean | undefined;
}): { readonly command: string; readonly args: ReadonlyArray<string> } {
  const setenvArgs = Object.entries(input.env).map(([key, value]) => `--setenv=${key}=${value}`);
  const systemdArgs = [
    "--scope",
    "--quiet",
    `--uid=${input.serviceUser}`,
    `--gid=${input.serviceGroup}`,
    `--working-directory=${input.cwd}`,
    ...setenvArgs,
    "--",
    input.command,
    ...input.args,
  ];
  if (input.useSudo) {
    return {
      command: "sudo",
      args: ["-n", "systemd-run", ...systemdArgs],
    };
  }
  return {
    command: "systemd-run",
    args: systemdArgs,
  };
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function appendGitConfigEntry(
  env: NodeJS.ProcessEnv,
  key: string,
  value: string,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const countKeys = Object.keys(env).filter((name) =>
    platform === "win32" ? name.toUpperCase() === "GIT_CONFIG_COUNT" : name === "GIT_CONFIG_COUNT",
  );
  const countKey = countKeys.at(-1) ?? "GIT_CONFIG_COUNT";
  const inherited = env[countKey];
  if (
    inherited !== undefined &&
    inherited !== "" &&
    /^[ \t\r\n\v\f]*(?:\+?\d+|-0+)/.exec(inherited)?.[0] !== inherited
  ) {
    return {};
  }
  const count = inherited === undefined || inherited === "" ? 0 : Number.parseInt(inherited, 10);
  return {
    ...Object.fromEntries([...countKeys, countKey].map((name) => [name, String(count + 1)])),
    [`GIT_CONFIG_KEY_${count}`]: key,
    [`GIT_CONFIG_VALUE_${count}`]: value,
  };
}

/**
 * Pure builder for L1 Git isolation env: per-service `safe.directory` entries, project-scoped
 * `GIT_SSH_COMMAND` (blocking host agent fallback via `SSH_AUTH_SOCK=""`), and `GIT_ASKPASS`.
 */
export function buildIsolatedGitEnv(input: {
  readonly safeDirectories: ReadonlyArray<string>;
  readonly sshKeyPath?: string | null | undefined;
  readonly sshKnownHostsPath?: string | null | undefined;
  readonly askpassPath?: string | null | undefined;
  readonly baseEnv?: NodeJS.ProcessEnv | undefined;
  readonly platform?: NodeJS.Platform | undefined;
}): NodeJS.ProcessEnv {
  const platform = input.platform ?? "linux";
  const result: NodeJS.ProcessEnv = {};
  const workingEnv: NodeJS.ProcessEnv = { ...input.baseEnv };

  const uniqueDirs = [...new Set(input.safeDirectories.filter((dir) => dir.trim().length > 0))];
  for (const dir of uniqueDirs) {
    const added = appendGitConfigEntry(workingEnv, "safe.directory", dir, platform);
    Object.assign(workingEnv, added);
    Object.assign(result, added);
  }

  if (input.sshKeyPath) {
    const knownHostsPart = input.sshKnownHostsPath
      ? ` -o UserKnownHostsFile=${shellSingleQuote(input.sshKnownHostsPath)}`
      : "";
    result.GIT_SSH_COMMAND = `ssh -i ${shellSingleQuote(input.sshKeyPath)} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new${knownHostsPart}`;
    // Prevent ambient host ssh-agent keys from authenticating L1 project repos.
    result.SSH_AUTH_SOCK = "";
  }

  if (input.askpassPath) {
    result.GIT_ASKPASS = input.askpassPath;
    result.GIT_TERMINAL_PROMPT = "0";
  }

  return result;
}

export function parseGetentPasswd(stdout: string): PasswdEntry | null {
  const line = stdout
    .split(/\r?\n/g)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (!line) return null;
  const fields = line.split(":");
  if (fields.length < 7) return null;
  const uid = Number.parseInt(fields[2] ?? "", 10);
  const gid = Number.parseInt(fields[3] ?? "", 10);
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) return null;
  return {
    username: fields[0] ?? "",
    uid,
    gid,
    homeDir: fields[5] ?? "",
    shell: fields[6] ?? "",
  };
}

export function parseGetentGroup(stdout: string): GroupEntry | null {
  const line = stdout
    .split(/\r?\n/g)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (!line) return null;
  const fields = line.split(":");
  if (fields.length < 4) return null;
  const gid = Number.parseInt(fields[2] ?? "", 10);
  if (!Number.isInteger(gid)) return null;
  const membersRaw = (fields[3] ?? "").trim();
  return {
    groupName: fields[0] ?? "",
    gid,
    members:
      membersRaw.length === 0
        ? []
        : membersRaw
            .split(",")
            .map((member) => member.trim())
            .filter((member) => member.length > 0),
  };
}

export function parseStatOwnerMode(stdout: string): StatOwnerMode | null {
  const line = stdout.trim();
  const match = /^(\S+)\s+(\S+)\s+([0-7]{3,4})$/.exec(line);
  if (!match) return null;
  return {
    owner: match[1] ?? "",
    group: match[2] ?? "",
    modeOctal: match[3] ?? "",
  };
}

export function isGroupRwsMode(modeOctal: string): boolean {
  const mode = Number.parseInt(modeOctal, 8);
  if (!Number.isInteger(mode)) return false;
  // Require setgid (0o2000) and group rwx (0o070) on directory.
  return (mode & 0o2070) === 0o2070;
}

function buildAskpassScript(input: {
  readonly usernameFilePath: string;
  readonly tokenFilePath: string;
}): string {
  return [
    "#!/bin/sh",
    'case "$1" in',
    `  *[Uu]sername*) cat ${shellSingleQuote(input.usernameFilePath)} ;;`,
    `  *) cat ${shellSingleQuote(input.tokenFilePath)} ;;`,
    "esac",
    "",
  ].join("\n");
}

function resolveCurrentUid(override?: number): number {
  if (override !== undefined) return override;
  return typeof process.getuid === "function" ? process.getuid() : -1;
}

function resolveCurrentUsername(override?: string | null): string | null {
  if (override !== undefined) return override;
  try {
    return NodeOS.userInfo().username;
  } catch {
    return null;
  }
}

export class ProjectIsolation extends Context.Service<
  ProjectIsolation,
  {
    readonly get: (
      projectId: ProjectId,
    ) => Effect.Effect<Option.Option<ProjectIsolationRecord>, ProjectIsolationPersistenceError>;
    readonly list: () => Effect.Effect<
      ReadonlyArray<ProjectIsolationRecord>,
      ProjectIsolationPersistenceError
    >;
    readonly enable: (
      projectId: ProjectId,
    ) => Effect.Effect<ProjectIsolationTransitionResult, ProjectIsolationError>;
    readonly disable: (
      projectId: ProjectId,
    ) => Effect.Effect<ProjectIsolationTransitionResult, ProjectIsolationError>;
    readonly adoptExisting: (
      projectId?: ProjectId,
    ) => Effect.Effect<ReadonlyArray<ProjectIsolationTransitionResult>, ProjectIsolationError>;
    readonly resolveForProject: (
      projectId: ProjectId,
    ) => Effect.Effect<Option.Option<ProjectIsolationRuntimeContext>>;
    readonly resolveForPath: (
      targetPath: string,
    ) => Effect.Effect<Option.Option<ProjectIsolationRuntimeContext>>;
    readonly resolveGitEnvForPath: (
      cwd: string,
      baseEnv?: NodeJS.ProcessEnv,
    ) => Effect.Effect<NodeJS.ProcessEnv>;
    readonly ensureWorktreeOwnership: (
      projectId: ProjectId,
      worktreePath: string,
    ) => Effect.Effect<void>;
    readonly isPortAllowedForProject: (
      projectId: ProjectId,
      port: number,
    ) => Effect.Effect<{
      readonly allowed: boolean;
      readonly level: ProjectIsolationLevel;
      readonly portsFrom: number | null;
      readonly portsTo: number | null;
    }>;
    readonly findByPort: (port: number) => Effect.Effect<Option.Option<ProjectIsolationRecord>>;
  }
>()("v3code/isolation/ProjectIsolation") {}

const make = Effect.gen(function* () {
  const repo = yield* ProjectIsolationRepo.ProjectIsolationRepository;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  const isolationConfig = yield* ProjectIsolationConfig;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const projectSecrets = yield* Effect.serviceOption(ProjectSecrets.ProjectSecrets);
  const projectLocks = yield* KeyedLock.make<ProjectId>();

  // Lightweight cache of active level-1 runtime contexts; invalidated on mutations so L0 stays O(1).
  let activeCache: ReadonlyArray<ProjectIsolationRuntimeContext> | null = null;
  const invalidateCache = () => {
    activeCache = null;
  };

  const currentUid = resolveCurrentUid(isolationConfig.currentUid);
  const currentUsername = resolveCurrentUsername(isolationConfig.currentUsername);
  const isRoot = currentUid === 0;

  const runCommand = Effect.fn("ProjectIsolation.runCommand")(function* (input: {
    readonly projectId: ProjectId;
    readonly stage: string;
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly privileged?: boolean;
    readonly allowedExitCodes?: ReadonlyArray<number>;
  }) {
    const useSudo = input.privileged === true && !isRoot;
    const command = useSudo ? "sudo" : input.command;
    const args = useSudo ? ["-n", input.command, ...input.args] : input.args;
    const result = yield* processRunner
      .run({
        command,
        args,
        timeout: OS_COMMAND_TIMEOUT,
        timeoutBehavior: "error",
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProjectIsolationCommandError({
              projectId: input.projectId,
              stage: input.stage,
              command: input.command,
              exitCode: null,
              cause,
            }),
        ),
      );

    const allowed = input.allowedExitCodes ?? [0];
    if (result.code === null || !allowed.includes(result.code)) {
      return yield* new ProjectIsolationCommandError({
        projectId: input.projectId,
        stage: input.stage,
        command: input.command,
        exitCode: result.code,
      });
    }
    return result;
  });

  const probeRootAccess = Effect.fn("ProjectIsolation.probeRootAccess")(function* () {
    if (platform !== "linux") {
      return { ok: false as const, reason: "unsupported_platform" };
    }
    if (isRoot) {
      return { ok: true as const, useSudo: false };
    }
    const probe = yield* processRunner
      .run({
        command: "sudo",
        args: ["-n", "true"],
        timeout: "5 seconds",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.orElseSucceed(() => null));
    if (probe !== null && !probe.timedOut && probe.code === 0) {
      return { ok: true as const, useSudo: true };
    }
    return { ok: false as const, reason: "root_unavailable" };
  });

  const queryGetentGroup = Effect.fn("ProjectIsolation.queryGetentGroup")(function* (
    projectId: ProjectId,
    groupName: string,
  ) {
    const res = yield* runCommand({
      projectId,
      stage: "getent-group",
      command: "getent",
      args: ["group", groupName],
      allowedExitCodes: [0, 2],
    });
    return res.code === 0 ? parseGetentGroup(res.stdout) : null;
  });

  const queryGetentPasswd = Effect.fn("ProjectIsolation.queryGetentPasswd")(function* (
    projectId: ProjectId,
    username: string,
  ) {
    const res = yield* runCommand({
      projectId,
      stage: "getent-passwd",
      command: "getent",
      args: ["passwd", username],
      allowedExitCodes: [0, 2],
    });
    return res.code === 0 ? parseGetentPasswd(res.stdout) : null;
  });

  const queryStat = Effect.fn("ProjectIsolation.queryStat")(function* (
    projectId: ProjectId,
    targetPath: string,
    stage: string,
  ) {
    const res = yield* runCommand({
      projectId,
      stage,
      command: "stat",
      args: ["-c", "%U %G %a", targetPath],
      privileged: true,
    });
    const parsed = parseStatOwnerMode(res.stdout);
    if (parsed === null) {
      return yield* new ProjectIsolationVerificationError({
        projectId,
        stage,
        expected: "valid stat owner/group/mode",
        observed: "unparseable stat output",
      });
    }
    return parsed;
  });

  const listProjectThreadWorktrees = Effect.fn("ProjectIsolation.listProjectThreadWorktrees")(
    function* (projectId: ProjectId) {
      const rows = yield* sql<{ readonly worktreePath: string }>`
        SELECT DISTINCT json_extract(payload_json, '$.worktreePath') AS "worktreePath"
        FROM orchestration_v2_projection_threads
        WHERE project_id = ${projectId}
          AND deleted_at IS NULL
          AND json_extract(payload_json, '$.worktreePath') IS NOT NULL
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.orElseSucceed(() => [] as ReadonlyArray<{ readonly worktreePath: string }>),
      );
      return rows
        .map((row) => row.worktreePath)
        .filter((worktreePath) => path.isAbsolute(worktreePath));
    },
  );

  const applyGroupRwsAndVerify = Effect.fn("ProjectIsolation.applyGroupRwsAndVerify")(function* (
    projectId: ProjectId,
    targetPath: string,
    serviceGroup: string,
    stage: string,
  ) {
    yield* runCommand({
      projectId,
      stage: `${stage}:chgrp`,
      command: "chgrp",
      args: ["-R", serviceGroup, targetPath],
      privileged: true,
    });
    yield* runCommand({
      projectId,
      stage: `${stage}:chmod-group`,
      command: "chmod",
      args: ["-R", "g+rwX", targetPath],
      privileged: true,
    });
    yield* runCommand({
      projectId,
      stage: `${stage}:chmod-setgid`,
      command: "chmod",
      args: ["g+rws", targetPath],
      privileged: true,
    });
    const observed = yield* queryStat(projectId, targetPath, `${stage}:verify`);
    if (observed.group !== serviceGroup || !isGroupRwsMode(observed.modeOctal)) {
      return yield* new ProjectIsolationVerificationError({
        projectId,
        stage: `${stage}:verify`,
        expected: `group=${serviceGroup} mode=g+rws`,
        observed: `group=${observed.group} mode=${observed.modeOctal}`,
      });
    }
  });

  const applyServiceStateDirAndVerify = Effect.fn("ProjectIsolation.applyServiceStateDirAndVerify")(
    function* (
      projectId: ProjectId,
      stateDirPath: string,
      serviceUser: string,
      serviceGroup: string,
    ) {
      yield* fileSystem.makeDirectory(stateDirPath, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectIsolationCommandError({
              projectId,
              stage: "state-dir:mkdir",
              command: "mkdir",
              exitCode: null,
              cause,
            }),
        ),
      );
      yield* runCommand({
        projectId,
        stage: "state-dir:chown",
        command: "chown",
        args: ["-R", `${serviceUser}:${serviceGroup}`, stateDirPath],
        privileged: true,
      });
      yield* runCommand({
        projectId,
        stage: "state-dir:chmod",
        command: "chmod",
        args: ["0700", stateDirPath],
        privileged: true,
      });
      const observed = yield* queryStat(projectId, stateDirPath, "state-dir:verify");
      if (observed.owner !== serviceUser || observed.modeOctal !== "700") {
        return yield* new ProjectIsolationVerificationError({
          projectId,
          stage: "state-dir:verify",
          expected: `owner=${serviceUser} mode=700`,
          observed: `owner=${observed.owner} mode=${observed.modeOctal}`,
        });
      }
    },
  );

  const ensureOsUserAndGroup = Effect.fn("ProjectIsolation.ensureOsUserAndGroup")(function* (
    projectId: ProjectId,
    serviceUser: string,
    serviceGroup: string,
  ) {
    let group = yield* queryGetentGroup(projectId, serviceGroup);
    if (group === null) {
      // Exit code 9 means the group was created concurrently by another call.
      yield* runCommand({
        projectId,
        stage: "create-group",
        command: "groupadd",
        args: ["--system", serviceGroup],
        privileged: true,
        allowedExitCodes: [0, 9],
      });
      group = yield* queryGetentGroup(projectId, serviceGroup);
      if (group === null) {
        return yield* new ProjectIsolationVerificationError({
          projectId,
          stage: "verify-group",
          expected: `group ${serviceGroup} present`,
          observed: "missing",
        });
      }
    }

    const expectedHome = `${isolationConfig.serviceHomeBase}/${serviceUser}`;
    let passwd = yield* queryGetentPasswd(projectId, serviceUser);
    if (passwd === null) {
      yield* runCommand({
        projectId,
        stage: "create-user",
        command: "useradd",
        args: [
          "--system",
          "--gid",
          serviceGroup,
          "--create-home",
          "--home-dir",
          expectedHome,
          "--shell",
          "/bin/bash",
          serviceUser,
        ],
        privileged: true,
        allowedExitCodes: [0, 9],
      });
      passwd = yield* queryGetentPasswd(projectId, serviceUser);
      if (passwd === null) {
        return yield* new ProjectIsolationVerificationError({
          projectId,
          stage: "verify-user",
          expected: `user ${serviceUser} present`,
          observed: "missing",
        });
      }
    }

    if (currentUsername && !isRoot && !group.members.includes(currentUsername)) {
      yield* runCommand({
        projectId,
        stage: "add-server-user-to-group",
        command: "usermod",
        args: ["-aG", serviceGroup, currentUsername],
        privileged: true,
      });
      const refreshedGroup = yield* queryGetentGroup(projectId, serviceGroup);
      if (refreshedGroup === null || !refreshedGroup.members.includes(currentUsername)) {
        return yield* new ProjectIsolationVerificationError({
          projectId,
          stage: "verify-group-membership",
          expected: `${currentUsername} in ${serviceGroup}`,
          observed: refreshedGroup ? refreshedGroup.members.join(",") || "empty" : "missing",
        });
      }
    }

    return passwd;
  });

  const persistRecord = Effect.fn("ProjectIsolation.persistRecord")(function* (
    record: ProjectIsolationRecord,
    operation: string,
  ) {
    yield* repo.upsert(record).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectIsolationPersistenceError({
            operation,
            projectId: record.projectId,
            cause,
          }),
      ),
    );
    invalidateCache();
    return record;
  });

  const provisionProjectUnlocked = Effect.fn("ProjectIsolation.provisionProjectUnlocked")(
    function* (projectId: ProjectId) {
      const projectRow = yield* projects.get(projectId).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectIsolationPersistenceError({
              operation: "readProject",
              projectId,
              cause,
            }),
        ),
      );
      if (Option.isNone(projectRow)) {
        return yield* new ProjectIsolationNotFoundError({ projectId });
      }

      const existing = yield* repo.get(projectId).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectIsolationPersistenceError({
              operation: "readIsolation",
              projectId,
              cause,
            }),
        ),
      );
      const existingRecord = Option.getOrUndefined(existing);
      const slug = deriveIsolationSlug({
        projectId,
        title: projectRow.value.title,
      });
      const serviceUser = TrimmedNonEmptyString.make(
        existingRecord?.serviceUser ?? deriveServiceUser(slug),
      );
      const serviceGroup = TrimmedNonEmptyString.make(
        existingRecord?.serviceGroup ?? deriveServiceGroup(slug),
      );
      const nowIso = DateTime.formatIso(yield* DateTime.now);

      const rootProbe = yield* probeRootAccess();
      if (!rootProbe.ok) {
        yield* Effect.logWarning(
          "L1 project isolation requested without root privileges; falling back to L0.",
          {
            projectId,
            reason: rootProbe.reason,
          },
        );
        const fallbackRecord: ProjectIsolationRecord = {
          projectId,
          level: 0,
          serviceUser: existingRecord?.serviceUser ?? null,
          serviceGroup: existingRecord?.serviceGroup ?? null,
          portsFrom: existingRecord?.portsFrom ?? null,
          portsTo: existingRecord?.portsTo ?? null,
          adoptionState: "fallback",
          fallbackReason: rootProbe.reason,
          adoptedAt: existingRecord?.adoptedAt ?? null,
          updatedAt: nowIso,
        };
        yield* persistRecord(fallbackRecord, "persistFallback");
        return {
          record: fallbackRecord,
          effectiveLevel: 0,
          fellBackToL0: true,
          fallbackReason: rootProbe.reason,
        } satisfies ProjectIsolationTransitionResult;
      }

      const allRecords = yield* repo.list().pipe(
        Effect.mapError(
          (cause) =>
            new ProjectIsolationPersistenceError({
              operation: "listIsolationForPorts",
              projectId,
              cause,
            }),
        ),
      );
      let portsFrom = existingRecord?.portsFrom ?? null;
      let portsTo = existingRecord?.portsTo ?? null;
      if (portsFrom === null || portsTo === null) {
        const usedRanges: Array<PortRange> = [];
        for (const record of allRecords) {
          if (record.projectId === projectId) continue;
          if (record.portsFrom !== null && record.portsTo !== null) {
            usedRanges.push({ portsFrom: record.portsFrom, portsTo: record.portsTo });
          }
        }
        const allocated = allocatePortRange(usedRanges, {
          base: isolationConfig.portRangeBase,
          size: isolationConfig.portRangeSize,
          max: isolationConfig.portRangeMax,
        });
        if (allocated === null) {
          return yield* new ProjectIsolationPortExhaustedError({
            projectId,
            base: isolationConfig.portRangeBase,
            max: isolationConfig.portRangeMax,
            blockSize: isolationConfig.portRangeSize,
          });
        }
        portsFrom = PositiveInt.make(allocated.portsFrom);
        portsTo = PositiveInt.make(allocated.portsTo);
      }

      yield* ensureOsUserAndGroup(projectId, serviceUser, serviceGroup);

      const projectWorktreesRoot = projectIsolatedWorktreesDir(config.worktreesDir, projectId);
      yield* fileSystem.makeDirectory(projectWorktreesRoot, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectIsolationCommandError({
              projectId,
              stage: "worktrees-dir:mkdir",
              command: "mkdir",
              exitCode: null,
              cause,
            }),
        ),
      );

      const workspaceExists = yield* fileSystem
        .exists(projectRow.value.workspaceRoot)
        .pipe(Effect.orElseSucceed(() => false));
      if (workspaceExists) {
        yield* applyGroupRwsAndVerify(
          projectId,
          projectRow.value.workspaceRoot,
          serviceGroup,
          "workspace-root",
        );
      }

      yield* applyGroupRwsAndVerify(
        projectId,
        projectWorktreesRoot,
        serviceGroup,
        "worktrees-root",
      );

      const threadWorktrees = yield* listProjectThreadWorktrees(projectId);
      for (const worktreePath of threadWorktrees) {
        if (isWithinRoot(path, worktreePath, projectWorktreesRoot)) continue;
        const exists = yield* fileSystem
          .exists(worktreePath)
          .pipe(Effect.orElseSucceed(() => false));
        if (exists) {
          yield* applyGroupRwsAndVerify(projectId, worktreePath, serviceGroup, "thread-worktree");
        }
      }

      const projectStatePath = projectIsolatedStateDir(config.stateDir, projectId);
      yield* applyServiceStateDirAndVerify(projectId, projectStatePath, serviceUser, serviceGroup);

      const adoptedAt = DateTime.formatIso(yield* DateTime.now);
      const enabledRecord: ProjectIsolationRecord = {
        projectId,
        level: 1,
        serviceUser,
        serviceGroup,
        portsFrom,
        portsTo,
        adoptionState: "adopted",
        fallbackReason: null,
        adoptedAt,
        updatedAt: adoptedAt,
      };
      yield* persistRecord(enabledRecord, "persistEnabled");

      return {
        record: enabledRecord,
        effectiveLevel: 1,
        fellBackToL0: false,
        fallbackReason: null,
      } satisfies ProjectIsolationTransitionResult;
    },
  );

  const enable: ProjectIsolation["Service"]["enable"] = Effect.fn("ProjectIsolation.enable")(
    function* (projectId) {
      return yield* projectLocks.withLock(projectId, provisionProjectUnlocked(projectId)).pipe(
        Effect.mapError((error) =>
          error._tag === "ProjectIsolationNotFoundError" ||
          error._tag === "ProjectIsolationPortExhaustedError" ||
          error._tag === "ProjectIsolationCommandError" ||
          error._tag === "ProjectIsolationVerificationError" ||
          error._tag === "ProjectIsolationPersistenceError"
            ? error
            : new ProjectIsolationPersistenceError({
                operation: "enableLock",
                projectId,
                cause: error,
              }),
        ),
      );
    },
  );

  const disableUnlocked = Effect.fn("ProjectIsolation.disableUnlocked")(function* (
    projectId: ProjectId,
  ) {
    const projectRow = yield* projects.get(projectId).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectIsolationPersistenceError({
            operation: "readProject",
            projectId,
            cause,
          }),
      ),
    );
    if (Option.isNone(projectRow)) {
      return yield* new ProjectIsolationNotFoundError({ projectId });
    }

    const existing = yield* repo.get(projectId).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectIsolationPersistenceError({
            operation: "readIsolation",
            projectId,
            cause,
          }),
      ),
    );
    const existingRecord = Option.getOrUndefined(existing);
    const nowIso = DateTime.formatIso(yield* DateTime.now);

    // Reverse group membership without deleting workspace files, worktrees, or service user home.
    if (existingRecord?.serviceGroup && currentUsername && !isRoot) {
      const rootProbe = yield* probeRootAccess();
      if (rootProbe.ok) {
        const group = yield* queryGetentGroup(projectId, existingRecord.serviceGroup);
        if (group !== null && group.members.includes(currentUsername)) {
          // Exit code 3 means the user is not a member of the group (safe for idempotency).
          yield* runCommand({
            projectId,
            stage: "remove-server-user-from-group",
            command: "gpasswd",
            args: ["-d", currentUsername, existingRecord.serviceGroup],
            privileged: true,
            allowedExitCodes: [0, 3],
          });
        }
      }
    }

    const disabledRecord: ProjectIsolationRecord = {
      projectId,
      level: 0,
      serviceUser: existingRecord?.serviceUser ?? null,
      serviceGroup: existingRecord?.serviceGroup ?? null,
      portsFrom: existingRecord?.portsFrom ?? null,
      portsTo: existingRecord?.portsTo ?? null,
      adoptionState: existingRecord === undefined ? "none" : "disabled",
      fallbackReason: null,
      adoptedAt: existingRecord?.adoptedAt ?? null,
      updatedAt: nowIso,
    };
    yield* persistRecord(disabledRecord, "persistDisabled");
    return {
      record: disabledRecord,
      effectiveLevel: 0,
      fellBackToL0: false,
      fallbackReason: null,
    } satisfies ProjectIsolationTransitionResult;
  });

  const disable: ProjectIsolation["Service"]["disable"] = Effect.fn("ProjectIsolation.disable")(
    function* (projectId) {
      return yield* projectLocks.withLock(projectId, disableUnlocked(projectId)).pipe(
        Effect.mapError((error) =>
          error._tag === "ProjectIsolationNotFoundError" ||
          error._tag === "ProjectIsolationCommandError" ||
          error._tag === "ProjectIsolationPersistenceError"
            ? error
            : new ProjectIsolationPersistenceError({
                operation: "disableLock",
                projectId,
                cause: error,
              }),
        ),
      );
    },
  );

  const adoptExisting: ProjectIsolation["Service"]["adoptExisting"] = Effect.fn(
    "ProjectIsolation.adoptExisting",
  )(function* (projectId) {
    if (projectId !== undefined) {
      return [yield* enable(projectId)];
    }
    const all = yield* repo.list().pipe(
      Effect.mapError(
        (cause) =>
          new ProjectIsolationPersistenceError({
            operation: "listForAdopt",
            cause,
          }),
      ),
    );
    const targets = all.filter(
      (record) => record.level === 1 || record.adoptionState === "pending",
    );
    const results: Array<ProjectIsolationTransitionResult> = [];
    for (const target of targets) {
      results.push(yield* enable(target.projectId));
    }
    return results;
  });

  const loadActiveContexts = Effect.fnUntraced(function* () {
    if (activeCache !== null) {
      return activeCache;
    }
    const activeRecords = yield* repo.listActiveLevel1().pipe(Effect.orElseSucceed(() => []));
    if (activeRecords.length === 0) {
      activeCache = [];
      return activeCache;
    }
    const contexts: Array<ProjectIsolationRuntimeContext> = [];
    for (const record of activeRecords) {
      if (record.level !== 1 || !record.serviceUser || !record.serviceGroup) continue;
      const projectRow = yield* projects
        .get(record.projectId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(projectRow)) continue;
      contexts.push({
        projectId: record.projectId,
        level: 1,
        serviceUser: record.serviceUser,
        serviceGroup: record.serviceGroup,
        serviceHome: `${isolationConfig.serviceHomeBase}/${record.serviceUser}`,
        workspaceRoot: path.resolve(projectRow.value.workspaceRoot),
        worktreesDir: path.resolve(
          projectIsolatedWorktreesDir(config.worktreesDir, record.projectId),
        ),
        stateDir: path.resolve(projectIsolatedStateDir(config.stateDir, record.projectId)),
        portsFrom: record.portsFrom,
        portsTo: record.portsTo,
        useSudo: !isRoot,
      });
    }
    activeCache = contexts;
    return contexts;
  });

  const resolveForProject: ProjectIsolation["Service"]["resolveForProject"] = Effect.fn(
    "ProjectIsolation.resolveForProject",
  )(function* (projectId) {
    const active = yield* loadActiveContexts();
    return Option.fromUndefinedOr(active.find((entry) => entry.projectId === projectId));
  });

  const resolveForPath: ProjectIsolation["Service"]["resolveForPath"] = Effect.fn(
    "ProjectIsolation.resolveForPath",
  )(function* (targetPath) {
    const active = yield* loadActiveContexts();
    if (active.length === 0) {
      return Option.none();
    }
    const resolvedTarget = path.resolve(targetPath);
    let best: {
      readonly context: ProjectIsolationRuntimeContext;
      readonly matchLen: number;
    } | null = null;
    for (const entry of active) {
      for (const candidateRoot of [entry.workspaceRoot, entry.worktreesDir]) {
        if (isWithinRoot(path, resolvedTarget, candidateRoot)) {
          if (best === null || candidateRoot.length > best.matchLen) {
            best = { context: entry, matchLen: candidateRoot.length };
          }
        }
      }
    }
    return best === null ? Option.none() : Option.some(best.context);
  });

  const readOptionalSecret = (projectId: ProjectId, name: string) => {
    if (Option.isNone(projectSecrets)) {
      return Effect.succeed<string | null>(null);
    }
    return projectSecrets.value
      .getValue({
        projectId,
        name,
        actor: SYSTEM_GIT_ISOLATION_ACTOR,
      })
      .pipe(Effect.orElseSucceed(() => null));
  };

  const materializeSecretFile = Effect.fnUntraced(function* (
    filePath: string,
    contents: string,
    mode: number,
  ) {
    yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fileSystem.writeFileString(filePath, contents);
    yield* fileSystem.chmod(filePath, mode).pipe(Effect.ignore);
    return filePath;
  });

  const resolveGitEnvForPath: ProjectIsolation["Service"]["resolveGitEnvForPath"] = Effect.fn(
    "ProjectIsolation.resolveGitEnvForPath",
  )(function* (cwd, baseEnv) {
    const matched = yield* resolveForPath(cwd);
    if (Option.isNone(matched)) {
      return {};
    }
    const ctx = matched.value;
    const gitCredDir = path.join(ctx.stateDir, "git");
    const safeDirectories = [ctx.workspaceRoot, path.resolve(cwd)];

    const [sshKey, knownHosts, httpToken, httpUsername] = yield* Effect.all(
      [
        readOptionalSecret(ctx.projectId, PROJECT_GIT_SSH_KEY_SECRET_NAME),
        readOptionalSecret(ctx.projectId, PROJECT_GIT_SSH_KNOWN_HOSTS_SECRET_NAME),
        readOptionalSecret(ctx.projectId, PROJECT_GIT_HTTP_TOKEN_SECRET_NAME),
        readOptionalSecret(ctx.projectId, PROJECT_GIT_HTTP_USERNAME_SECRET_NAME),
      ],
      { concurrency: 4 },
    );

    let sshKeyPath: string | null = null;
    let sshKnownHostsPath: string | null = null;
    let askpassPath: string | null = null;

    if (sshKey !== null && sshKey.trim().length > 0) {
      const normalizedKey = sshKey.endsWith("\n") ? sshKey : `${sshKey}\n`;
      sshKeyPath = yield* materializeSecretFile(
        path.join(gitCredDir, "id_key"),
        normalizedKey,
        0o600,
      ).pipe(Effect.orElseSucceed(() => null));
      const knownHostsTarget = path.join(gitCredDir, "known_hosts");
      if (knownHosts !== null && knownHosts.trim().length > 0) {
        sshKnownHostsPath = yield* materializeSecretFile(
          knownHostsTarget,
          knownHosts.endsWith("\n") ? knownHosts : `${knownHosts}\n`,
          0o600,
        ).pipe(Effect.orElseSucceed(() => null));
      } else {
        sshKnownHostsPath = knownHostsTarget;
      }
    }

    if (httpToken !== null && httpToken.length > 0) {
      const usernameFilePath = path.join(gitCredDir, "http_username");
      const tokenFilePath = path.join(gitCredDir, "http_token");
      const scriptPath = path.join(gitCredDir, "askpass.sh");
      const effectiveUsername =
        httpUsername !== null && httpUsername.trim().length > 0
          ? httpUsername.trim()
          : DEFAULT_GIT_HTTP_USERNAME;
      const prepared = yield* Effect.all([
        materializeSecretFile(usernameFilePath, `${effectiveUsername}\n`, 0o600),
        materializeSecretFile(tokenFilePath, `${httpToken}\n`, 0o600),
        materializeSecretFile(
          scriptPath,
          buildAskpassScript({ usernameFilePath, tokenFilePath }),
          0o700,
        ),
      ]).pipe(
        Effect.as(scriptPath),
        Effect.orElseSucceed(() => null),
      );
      askpassPath = prepared;
    }

    return buildIsolatedGitEnv({
      safeDirectories,
      sshKeyPath,
      sshKnownHostsPath,
      askpassPath,
      baseEnv,
      platform,
    });
  });

  const ensureWorktreeOwnership: ProjectIsolation["Service"]["ensureWorktreeOwnership"] = Effect.fn(
    "ProjectIsolation.ensureWorktreeOwnership",
  )(function* (projectId, worktreePath) {
    const matched = yield* resolveForProject(projectId);
    if (Option.isNone(matched)) return;
    const rootProbe = yield* probeRootAccess();
    if (!rootProbe.ok) return;
    yield* applyGroupRwsAndVerify(
      projectId,
      matched.value.worktreesDir,
      matched.value.serviceGroup,
      "worktree-parent",
    ).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("Failed to apply L1 group ownership to project worktrees directory.", {
          projectId,
          cause,
        }),
      ),
      Effect.ignore,
    );
    yield* applyGroupRwsAndVerify(
      projectId,
      worktreePath,
      matched.value.serviceGroup,
      "worktree-checkout",
    ).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("Failed to apply L1 group ownership to created worktree.", {
          projectId,
          cause,
        }),
      ),
      Effect.ignore,
    );
  });

  const isPortAllowedForProject: ProjectIsolation["Service"]["isPortAllowedForProject"] = Effect.fn(
    "ProjectIsolation.isPortAllowedForProject",
  )(function* (projectId, port) {
    const recordOption = yield* repo.get(projectId).pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(recordOption) || recordOption.value.level !== 1) {
      return { allowed: true, level: 0 as const, portsFrom: null, portsTo: null };
    }
    const { portsFrom, portsTo } = recordOption.value;
    if (portsFrom === null || portsTo === null) {
      return { allowed: false, level: 1 as const, portsFrom: null, portsTo: null };
    }
    return {
      allowed: port >= portsFrom && port <= portsTo,
      level: 1 as const,
      portsFrom,
      portsTo,
    };
  });

  const findByPort: ProjectIsolation["Service"]["findByPort"] = Effect.fn(
    "ProjectIsolation.findByPort",
  )(function* (port) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return Option.none();
    }
    return yield* repo.findByPort(port).pipe(Effect.orElseSucceed(() => Option.none()));
  });

  return ProjectIsolation.of({
    get: Effect.fn("ProjectIsolation.get")((projectId) =>
      repo.get(projectId).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectIsolationPersistenceError({
              operation: "get",
              projectId,
              cause,
            }),
        ),
      ),
    ),
    list: Effect.fn("ProjectIsolation.list")(() =>
      repo.list().pipe(
        Effect.mapError(
          (cause) =>
            new ProjectIsolationPersistenceError({
              operation: "list",
              cause,
            }),
        ),
      ),
    ),
    enable,
    disable,
    adoptExisting,
    resolveForProject,
    resolveForPath,
    resolveGitEnvForPath,
    ensureWorktreeOwnership,
    isPortAllowedForProject,
    findByPort,
  });
});

export const layer = Layer.effect(ProjectIsolation, make);
