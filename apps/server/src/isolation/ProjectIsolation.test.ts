// @effect-diagnostics nodeBuiltinImport:off -- integration check uses node:child_process/node:os for non-destructive host capability probing.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthSessionId,
  AuthSettingsWriteScope,
  CommandId,
  EventId,
  PrincipalId,
  PROJECT_GIT_HTTP_TOKEN_SECRET_NAME,
  PROJECT_GIT_HTTP_USERNAME_SECRET_NAME,
  PROJECT_GIT_SSH_KEY_SECRET_NAME,
  ProjectId,
  WS_METHODS,
  requiredScopesForProjectMutation,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { Command } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import * as ProjectAccess from "../access/ProjectAccess.ts";
import { capabilityForRpcCall } from "../access/ResourceResolver.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { cli } from "../binCli.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as AuditEvents from "../persistence/AuditEvents.ts";
import * as Memberships from "../persistence/Memberships.ts";
import * as Principals from "../persistence/Principals.ts";
import * as ProjectIsolationRepo from "../persistence/ProjectIsolationRepo.ts";
import * as ProjectSecretRepo from "../persistence/ProjectSecrets.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectSecrets from "../project/ProjectSecrets.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectIsolation from "./ProjectIsolation.ts";

interface FakeOsState {
  readonly groups: Map<string, Set<string>>;
  readonly users: Map<string, { readonly gid: string; readonly homeDir: string }>;
  readonly owners: Map<string, { owner: string; group: string; modeOctal: string }>;
  readonly commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }>;
  sudoAllowed: boolean;
  forceVerifyMismatchPath?: string | undefined;
}

function makeFakeOsState(sudoAllowed = true): FakeOsState {
  return {
    groups: new Map(),
    users: new Map(),
    owners: new Map(),
    commands: [],
    sudoAllowed,
  };
}

function makeFakeProcessRunnerLayer(state: FakeOsState) {
  const ok = (stdout = "", code = 0): ProcessRunner.ProcessRunOutput => ({
    stdout,
    stderr: "",
    code: ChildProcessSpawner.ExitCode(code),
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutInvalidUtf8: false,
    stderrInvalidUtf8: false,
  });

  return Layer.succeed(
    ProcessRunner.ProcessRunner,
    ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Effect.sync(() => {
          state.commands.push({ command: input.command, args: [...input.args] });

          let cmd = input.command;
          let args = [...input.args];
          if (cmd === "sudo") {
            if (args[0] === "-n") {
              args = args.slice(1);
            }
            if (args[0] === "true") {
              return ok("", state.sudoAllowed ? 0 : 1);
            }
            if (!state.sudoAllowed) {
              return ok("", 1);
            }
            cmd = args[0] ?? "";
            args = args.slice(1);
          }

          if (cmd === "getent") {
            const db = args[0];
            const key = args[1] ?? "";
            if (db === "group") {
              const members = state.groups.get(key);
              if (!members) return ok("", 2);
              return ok(`${key}:x:1500:${[...members].join(",")}\n`, 0);
            }
            if (db === "passwd") {
              const user = state.users.get(key);
              if (!user) return ok("", 2);
              return ok(`${key}:x:1500:1500::${user.homeDir}:/bin/bash\n`, 0);
            }
            return ok("", 2);
          }

          if (cmd === "groupadd") {
            const groupName = args.at(-1) ?? "";
            if (state.groups.has(groupName)) return ok("", 9);
            state.groups.set(groupName, new Set());
            return ok("", 0);
          }

          if (cmd === "useradd") {
            const username = args.at(-1) ?? "";
            const gidIndex = args.indexOf("--gid");
            const homeIndex = args.indexOf("--home-dir");
            const gid = gidIndex >= 0 ? (args[gidIndex + 1] ?? "") : "";
            const homeDir =
              homeIndex >= 0 ? (args[homeIndex + 1] ?? `/home/${username}`) : `/home/${username}`;
            if (state.users.has(username)) return ok("", 9);
            state.users.set(username, { gid, homeDir });
            return ok("", 0);
          }

          if (cmd === "usermod") {
            const groupName = args[1] ?? "";
            const username = args[2] ?? "";
            const members = state.groups.get(groupName);
            if (!members) return ok("", 6);
            members.add(username);
            return ok("", 0);
          }

          if (cmd === "gpasswd") {
            const username = args[1] ?? "";
            const groupName = args[2] ?? "";
            const members = state.groups.get(groupName);
            if (!members || !members.has(username)) return ok("", 3);
            members.delete(username);
            return ok("", 0);
          }

          if (cmd === "chgrp") {
            const groupName = args[1] ?? "";
            const target = args[2] ?? "";
            const current = state.owners.get(target) ?? {
              owner: "teamops",
              group: "teamops",
              modeOctal: "755",
            };
            state.owners.set(target, { ...current, group: groupName });
            return ok("", 0);
          }

          if (cmd === "chown") {
            const spec = args[1] ?? "";
            const target = args[2] ?? "";
            const [owner = "root", group = "root"] = spec.split(":");
            const current = state.owners.get(target) ?? {
              owner: "teamops",
              group: "teamops",
              modeOctal: "755",
            };
            state.owners.set(target, { ...current, owner, group });
            return ok("", 0);
          }

          if (cmd === "chmod") {
            const isRecursive = args[0] === "-R";
            const modeSpec = isRecursive ? (args[1] ?? "") : (args[0] ?? "");
            const target = isRecursive ? (args[2] ?? "") : (args[1] ?? "");
            const current = state.owners.get(target) ?? {
              owner: "teamops",
              group: "teamops",
              modeOctal: "755",
            };
            let nextMode = current.modeOctal;
            if (modeSpec === "0700" || modeSpec === "700") {
              nextMode = "700";
            } else if (modeSpec === "g+rws") {
              nextMode = "2775";
            } else if (modeSpec === "g+rwX") {
              nextMode = current.modeOctal === "2775" ? "2775" : "775";
            }
            state.owners.set(target, { ...current, modeOctal: nextMode });
            return ok("", 0);
          }

          if (cmd === "stat") {
            const target = args.at(-1) ?? "";
            if (state.forceVerifyMismatchPath === target) {
              return ok("wronguser wronggroup 755\n", 0);
            }
            const info = state.owners.get(target) ?? {
              owner: "teamops",
              group: "teamops",
              modeOctal: "755",
            };
            return ok(`${info.owner} ${info.group} ${info.modeOctal}\n`, 0);
          }

          return ok("", 0);
        }),
    }),
  );
}

const seedProject = Effect.fn("ProjectIsolationTest.seedProject")(function* (input: {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
}) {
  const store = yield* ProjectStore.ProjectStoreV2;
  const now = DateTime.formatIso(yield* DateTime.now);
  yield* store.apply({
    sequence: 1,
    eventId: EventId.make(`evt-${input.projectId}`),
    aggregateKind: "project",
    aggregateId: input.projectId,
    type: "project.created",
    occurredAt: now,
    commandId: CommandId.make(`cmd-${input.projectId}`),
    causationEventId: null,
    correlationId: CommandId.make(`cmd-${input.projectId}`),
    metadata: {},
    payload: {
      projectId: input.projectId,
      title: input.title,
      workspaceRoot: input.workspaceRoot,
      defaultModelSelection: null,
      faviconPath: null,
      projectIcon: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });
});

function makeIsolationTestLayer(options: {
  readonly osState: FakeOsState;
  readonly baseDir: string;
  readonly platform?: NodeJS.Platform;
  readonly isolationConfig?: Partial<ProjectIsolation.ProjectIsolationSettings>;
}) {
  const persistence = SqlitePersistence.layerMemory;
  const config = ServerConfig.layerTest(options.baseDir, options.baseDir);
  const processRunner = makeFakeProcessRunnerLayer(options.osState);
  const projectStore = ProjectStore.layer.pipe(Layer.provide(persistence));
  const isolationRepo = ProjectIsolationRepo.layer.pipe(Layer.provide(persistence));
  const secretsRepo = ProjectSecretRepo.layer.pipe(Layer.provide(persistence));
  const identityRepos = Layer.mergeAll(Principals.layer, Memberships.layer, AuditEvents.layer).pipe(
    Layer.provide(persistence),
  );
  const projectAccess = ProjectAccess.layer.pipe(
    Layer.provide(identityRepos),
    Layer.provide(projectStore),
    Layer.provide(persistence),
  );
  const projectSecrets = ProjectSecrets.layer.pipe(
    Layer.provide(secretsRepo),
    Layer.provide(identityRepos),
    Layer.provide(projectAccess),
    Layer.provide(persistence),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(config),
  );
  const isolationConfigLayer = Layer.succeed(ProjectIsolation.ProjectIsolationConfig, {
    portRangeBase:
      options.isolationConfig?.portRangeBase ?? ProjectIsolation.DEFAULT_ISOLATION_PORT_RANGE_BASE,
    portRangeSize:
      options.isolationConfig?.portRangeSize ?? ProjectIsolation.DEFAULT_ISOLATION_PORT_RANGE_SIZE,
    portRangeMax:
      options.isolationConfig?.portRangeMax ?? ProjectIsolation.DEFAULT_ISOLATION_PORT_RANGE_MAX,
    serviceHomeBase:
      options.isolationConfig?.serviceHomeBase ?? ProjectIsolation.DEFAULT_SERVICE_HOME_BASE,
    currentUid: options.isolationConfig?.currentUid ?? 1000,
    currentUsername:
      options.isolationConfig?.currentUsername !== undefined
        ? options.isolationConfig.currentUsername
        : "teamops",
  });
  const platformLayer = Layer.succeed(HostProcess.Platform, options.platform ?? "linux");

  const isolation = ProjectIsolation.layer.pipe(
    Layer.provide(isolationRepo),
    Layer.provide(projectStore),
    Layer.provide(processRunner),
    Layer.provide(persistence),
    Layer.provide(config),
    Layer.provide(isolationConfigLayer),
    Layer.provide(platformLayer),
    Layer.provide(projectSecrets),
  );

  return Layer.mergeAll(
    isolation,
    isolationRepo,
    projectStore,
    projectSecrets,
    projectAccess,
    config,
    persistence,
    processRunner,
    platformLayer,
    isolationConfigLayer,
  ).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));
}

describe("ProjectIsolation pure helpers", () => {
  it("derives stable, Linux-safe slugs, service users, and groups", () => {
    const slugA = ProjectIsolation.deriveIsolationSlug({
      projectId: "proj-alpha-123",
      title: "My Awesome CRM!!! (Prod)",
    });
    const slugA2 = ProjectIsolation.deriveIsolationSlug({
      projectId: "proj-alpha-123",
      title: "My Awesome CRM!!! (Prod)",
    });
    const slugB = ProjectIsolation.deriveIsolationSlug({
      projectId: "proj-beta-456",
      title: "My Awesome CRM!!! (Prod)",
    });
    const slugEmpty = ProjectIsolation.deriveIsolationSlug({
      projectId: "proj-empty",
      title: "   ",
    });

    assert.equal(slugA, slugA2);
    assert.notEqual(slugA, slugB);
    assert.match(slugA, /^[a-z0-9][a-z0-9-]{0,23}$/);
    assert.match(slugEmpty, /^p-[a-f0-9]{6}$/);
    assert.isAtMost(ProjectIsolation.deriveServiceUser(slugA).length, 28);
    assert.isAtMost(ProjectIsolation.deriveServiceGroup(slugA).length, 27);
    assert.isTrue(ProjectIsolation.deriveServiceUser(slugA).startsWith("svc-"));
    assert.isTrue(ProjectIsolation.deriveServiceGroup(slugA).startsWith("t3-"));
  });

  it("allocates non-overlapping port blocks from a configurable base and reports exhaustion", () => {
    const first = ProjectIsolation.allocatePortRange([], { base: 30_000, size: 50, max: 30_149 });
    assert.deepEqual(first, { portsFrom: 30_000, portsTo: 30_049 });

    const second = ProjectIsolation.allocatePortRange([first!], {
      base: 30_000,
      size: 50,
      max: 30_149,
    });
    assert.deepEqual(second, { portsFrom: 30_050, portsTo: 30_099 });

    // Skips a custom overlapping range and fills the next available slot.
    const third = ProjectIsolation.allocatePortRange(
      [first!, { portsFrom: 30_040, portsTo: 30_080 }],
      { base: 30_000, size: 50, max: 30_149 },
    );
    assert.deepEqual(third, { portsFrom: 30_100, portsTo: 30_149 });

    const exhausted = ProjectIsolation.allocatePortRange(
      [
        { portsFrom: 30_000, portsTo: 30_049 },
        { portsFrom: 30_050, portsTo: 30_099 },
        { portsFrom: 30_100, portsTo: 30_149 },
      ],
      { base: 30_000, size: 50, max: 30_149 },
    );
    assert.isNull(exhausted);
  });

  it("builds a strict env allowlist excluding host secrets and ambient vars", () => {
    const env = ProjectIsolation.buildIsolatedTerminalEnv({
      serviceUser: "svc-kotcrm-abc123",
      projectId: "proj-1",
      memberId: "mem-42",
      baseEnv: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        LANG: "en_US.UTF-8",
        TERM: "xterm-256color",
        HOME: "/home/host-owner",
        OPENAI_API_KEY: "sk-secret",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
        SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
        GH_TOKEN: "ghp_secret",
        T3CODE_TOKEN: "t3-secret",
      },
    });

    assert.deepEqual(env, {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/home/svc-kotcrm-abc123",
      T3_PROJECT_ID: "proj-1",
      T3_MEMBER_ID: "mem-42",
      LANG: "en_US.UTF-8",
      TERM: "xterm-256color",
    });
    assert.isUndefined(env.OPENAI_API_KEY);
    assert.isUndefined(env.AWS_SECRET_ACCESS_KEY);
    assert.isUndefined(env.SSH_AUTH_SOCK);
    assert.isUndefined(env.GH_TOKEN);
  });

  it("wraps L1 terminal commands with systemd-run --scope --uid --gid", () => {
    const direct = ProjectIsolation.buildSystemdRunCommand({
      serviceUser: "svc-demo-123456",
      serviceGroup: "t3-demo-123456",
      cwd: "/srv/projects/demo",
      command: "/bin/bash",
      args: ["-i"],
      env: { HOME: "/home/svc-demo-123456", T3_PROJECT_ID: "proj-1" },
      useSudo: false,
    });
    assert.equal(direct.command, "systemd-run");
    assert.include(direct.args, "--scope");
    assert.include(direct.args, "--uid=svc-demo-123456");
    assert.include(direct.args, "--gid=t3-demo-123456");
    assert.include(direct.args, "--working-directory=/srv/projects/demo");
    assert.include(direct.args, "--setenv=HOME=/home/svc-demo-123456");
    assert.deepEqual(direct.args.slice(-3), ["--", "/bin/bash", "-i"]);

    const viaSudo = ProjectIsolation.buildSystemdRunCommand({
      serviceUser: "svc-demo-123456",
      serviceGroup: "t3-demo-123456",
      cwd: "/srv/projects/demo",
      command: "/bin/bash",
      args: [],
      env: { HOME: "/home/svc-demo-123456" },
      useSudo: true,
    });
    assert.equal(viaSudo.command, "sudo");
    assert.equal(viaSudo.args[0], "-n");
    assert.equal(viaSudo.args[1], "systemd-run");
  });

  it("builds L1 Git env with safe.directory, GIT_SSH_COMMAND, and GIT_ASKPASS", () => {
    const gitEnv = ProjectIsolation.buildIsolatedGitEnv({
      safeDirectories: ["/srv/proj", "/srv/worktrees/proj-1/feat"],
      sshKeyPath: "/var/t3/projects/proj-1/git/id_key",
      sshKnownHostsPath: "/var/t3/projects/proj-1/git/known_hosts",
      askpassPath: "/var/t3/projects/proj-1/git/askpass.sh",
      baseEnv: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "gc.auto",
        GIT_CONFIG_VALUE_0: "0",
      },
      platform: "linux",
    });

    assert.equal(gitEnv.GIT_CONFIG_COUNT, "3");
    assert.equal(gitEnv.GIT_CONFIG_KEY_1, "safe.directory");
    assert.equal(gitEnv.GIT_CONFIG_VALUE_1, "/srv/proj");
    assert.equal(gitEnv.GIT_CONFIG_KEY_2, "safe.directory");
    assert.equal(gitEnv.GIT_CONFIG_VALUE_2, "/srv/worktrees/proj-1/feat");
    assert.include(gitEnv.GIT_SSH_COMMAND ?? "", "IdentitiesOnly=yes");
    assert.include(gitEnv.GIT_SSH_COMMAND ?? "", "/var/t3/projects/proj-1/git/id_key");
    assert.equal(gitEnv.SSH_AUTH_SOCK, "");
    assert.equal(gitEnv.GIT_ASKPASS, "/var/t3/projects/proj-1/git/askpass.sh");
    assert.equal(gitEnv.GIT_TERMINAL_PROMPT, "0");
  });

  it("gates project.update isolationLevel changes behind project:settings and settings:write", () => {
    const mutation = {
      type: "project.update" as const,
      commandId: CommandId.make("cmd-iso-1"),
      projectId: ProjectId.make("proj-1"),
      isolationLevel: 1 as const,
    };
    const scopes = requiredScopesForProjectMutation(mutation);
    assert.include(scopes, AuthOrchestrationOperateScope);
    assert.include(scopes, AuthSettingsWriteScope);
    assert.equal(capabilityForRpcCall(WS_METHODS.projectsMutate, mutation), "project:settings");
  });
});

describe("ProjectIsolation service", () => {
  it.effect(
    "enables L1 idempotently, allocates unique ports, disables cleanly, and adopts existing",
    () =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-iso-service-"));
        const workspaceA = NodePath.join(baseDir, "ws-alpha");
        const workspaceB = NodePath.join(baseDir, "ws-beta");
        NodeFS.mkdirSync(workspaceA, { recursive: true });
        NodeFS.mkdirSync(workspaceB, { recursive: true });
        const osState = makeFakeOsState(true);

        const layer = makeIsolationTestLayer({
          osState,
          baseDir,
          isolationConfig: { portRangeBase: 25_000, portRangeSize: 100, portRangeMax: 25_299 },
        });

        yield* Effect.gen(function* () {
          const isolation = yield* ProjectIsolation.ProjectIsolation;
          const projA = ProjectId.make("proj-alpha");
          const projB = ProjectId.make("proj-beta");
          yield* seedProject({ projectId: projA, title: "Alpha CRM", workspaceRoot: workspaceA });
          yield* seedProject({ projectId: projB, title: "Beta CRM", workspaceRoot: workspaceB });

          const firstEnable = yield* isolation.enable(projA);
          assert.equal(firstEnable.effectiveLevel, 1);
          assert.equal(firstEnable.fellBackToL0, false);
          assert.equal(firstEnable.record.adoptionState, "adopted");
          assert.equal(firstEnable.record.portsFrom, 25_000);
          assert.equal(firstEnable.record.portsTo, 25_099);
          assert.isTrue(firstEnable.record.serviceUser?.startsWith("svc-alpha-crm-"));
          assert.isTrue(firstEnable.record.serviceGroup?.startsWith("t3-alpha-crm-"));

          // Verify idempotent re-enable keeps the exact user, group, and port range without re-creating OS entities.
          const cmdsBeforeRetry = osState.commands.length;
          const secondEnable = yield* isolation.enable(projA);
          assert.equal(secondEnable.record.serviceUser, firstEnable.record.serviceUser);
          assert.equal(secondEnable.record.portsFrom, 25_000);
          const retryCommands = osState.commands
            .slice(cmdsBeforeRetry)
            .map((c) => `${c.command} ${c.args.join(" ")}`);
          assert.isFalse(retryCommands.some((line) => line.includes("useradd")));
          assert.isFalse(retryCommands.some((line) => line.includes("groupadd")));

          // Second project receives the next non-overlapping port block.
          const betaEnable = yield* isolation.enable(projB);
          assert.equal(betaEnable.record.portsFrom, 25_100);
          assert.equal(betaEnable.record.portsTo, 25_199);

          // Preview port gating checks project_isolation ranges.
          const inRange = yield* isolation.isPortAllowedForProject(projA, 25_042);
          assert.equal(inRange.allowed, true);
          const outOfRange = yield* isolation.isPortAllowedForProject(projA, 25_150);
          assert.equal(outOfRange.allowed, false);
          assert.equal(outOfRange.portsFrom, 25_000);
          assert.equal(outOfRange.portsTo, 25_099);

          const foundByPort = yield* isolation.findByPort(25_150);
          assert.isTrue(Option.isSome(foundByPort));
          if (Option.isSome(foundByPort)) {
            assert.equal(foundByPort.value.projectId, projB);
          }

          // adoptExisting re-applies ownership for active L1 projects.
          const adopted = yield* isolation.adoptExisting();
          assert.equal(adopted.length, 2);
          assert.isTrue(adopted.every((entry) => entry.effectiveLevel === 1));

          // disable() reverses group membership without deleting workspace files.
          const markerFile = NodePath.join(workspaceA, "keep.txt");
          NodeFS.writeFileSync(markerFile, "important work");
          const disabled = yield* isolation.disable(projA);
          assert.equal(disabled.effectiveLevel, 0);
          assert.equal(disabled.record.adoptionState, "disabled");
          assert.isTrue(NodeFS.existsSync(markerFile));
          assert.isFalse(osState.groups.get(firstEnable.record.serviceGroup!)?.has("teamops"));

          // L0 project allows any preview port.
          const l0Port = yield* isolation.isPortAllowedForProject(projA, 3000);
          assert.equal(l0Port.allowed, true);
          assert.equal(l0Port.level, 0);
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect(
    "falls back to L0 with a noted reason when sudo -n true fails or platform is non-Linux",
    () =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-iso-fallback-"));
        const workspace = NodePath.join(baseDir, "ws");
        NodeFS.mkdirSync(workspace, { recursive: true });

        const noRootState = makeFakeOsState(false);
        yield* Effect.gen(function* () {
          const isolation = yield* ProjectIsolation.ProjectIsolation;
          const proj = ProjectId.make("proj-noroot");
          yield* seedProject({ projectId: proj, title: "NoRoot", workspaceRoot: workspace });

          const res = yield* isolation.enable(proj);
          assert.equal(res.effectiveLevel, 0);
          assert.equal(res.fellBackToL0, true);
          assert.equal(res.fallbackReason, "root_unavailable");
          assert.equal(res.record.adoptionState, "fallback");
        }).pipe(Effect.provide(makeIsolationTestLayer({ osState: noRootState, baseDir })));

        const macState = makeFakeOsState(true);
        yield* Effect.gen(function* () {
          const isolation = yield* ProjectIsolation.ProjectIsolation;
          const proj = ProjectId.make("proj-darwin");
          yield* seedProject({ projectId: proj, title: "Darwin", workspaceRoot: workspace });

          const res = yield* isolation.enable(proj);
          assert.equal(res.effectiveLevel, 0);
          assert.equal(res.fellBackToL0, true);
          assert.equal(res.fallbackReason, "unsupported_platform");
          assert.equal(res.record.adoptionState, "fallback");
        }).pipe(
          Effect.provide(
            makeIsolationTestLayer({ osState: macState, baseDir, platform: "darwin" }),
          ),
        );
      }),
  );

  it.effect("surfaces stat verification mismatch as typed ProjectIsolationVerificationError", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-iso-verify-"));
      const workspace = NodePath.join(baseDir, "ws");
      NodeFS.mkdirSync(workspace, { recursive: true });
      const osState = makeFakeOsState(true);
      osState.forceVerifyMismatchPath = workspace;

      const result = yield* Effect.gen(function* () {
        const isolation = yield* ProjectIsolation.ProjectIsolation;
        const proj = ProjectId.make("proj-mismatch");
        yield* seedProject({ projectId: proj, title: "Mismatch", workspaceRoot: workspace });
        return yield* Effect.result(isolation.enable(proj));
      }).pipe(Effect.provide(makeIsolationTestLayer({ osState, baseDir })));

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "ProjectIsolationVerificationError");
      }
    }),
  );

  it.effect(
    "materializes L1 Git SSH key and askpass from project secrets and sets safe.directory",
    () =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-iso-git-"));
        const workspace = NodePath.join(baseDir, "ws-git");
        NodeFS.mkdirSync(workspace, { recursive: true });
        const osState = makeFakeOsState(true);

        yield* Effect.gen(function* () {
          const isolation = yield* ProjectIsolation.ProjectIsolation;
          const secrets = yield* ProjectSecrets.ProjectSecrets;
          const proj = ProjectId.make("proj-git");
          yield* seedProject({ projectId: proj, title: "GitProj", workspaceRoot: workspace });

          // L0 returns empty env.
          const l0Env = yield* isolation.resolveGitEnvForPath(workspace);
          assert.deepEqual(l0Env, {});

          yield* isolation.enable(proj);

          const ownerActor: ProjectAccess.AccessActor = {
            sessionId: AuthSessionId.make("sess-owner"),
            subject: "owner",
            scopes: [],
            binding: { _tag: "environment" },
            isOwner: true,
            roles: new Map(),
          };
          yield* secrets.set({
            projectId: proj,
            name: PROJECT_GIT_SSH_KEY_SECRET_NAME,
            value:
              "-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE-KEY\n-----END OPENSSH PRIVATE KEY-----",
            actor: ownerActor,
          });
          yield* secrets.set({
            projectId: proj,
            name: PROJECT_GIT_HTTP_TOKEN_SECRET_NAME,
            value: "ghp_project_token_123",
            actor: ownerActor,
          });
          yield* secrets.set({
            projectId: proj,
            name: PROJECT_GIT_HTTP_USERNAME_SECRET_NAME,
            value: "deploy-bot",
            actor: ownerActor,
          });

          const l1Env = yield* isolation.resolveGitEnvForPath(workspace);
          assert.equal(l1Env.GIT_CONFIG_KEY_0, "safe.directory");
          assert.equal(l1Env.GIT_CONFIG_VALUE_0, workspace);
          assert.include(l1Env.GIT_SSH_COMMAND ?? "", "id_key");
          assert.equal(l1Env.SSH_AUTH_SOCK, "");
          assert.isDefined(l1Env.GIT_ASKPASS);
          assert.equal(l1Env.GIT_TERMINAL_PROMPT, "0");
          assert.isTrue(NodeFS.existsSync(l1Env.GIT_ASKPASS!));
        }).pipe(Effect.provide(makeIsolationTestLayer({ osState, baseDir })));
      }),
  );

  it.effect(
    "spawns L1 terminal via systemd-run with strict env allowlist and keeps L0 normal",
    () =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-iso-term-"));
        const workspace = NodePath.join(baseDir, "ws-term");
        NodeFS.mkdirSync(workspace, { recursive: true });
        const spawnCalls: Array<PtyAdapter.PtySpawnInput> = [];

        const fakePtyAdapter = PtyAdapter.PtyAdapter.of({
          spawn: (input) =>
            Effect.sync(() => {
              spawnCalls.push(input);
              const exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
              return {
                pid: 42_000 + spawnCalls.length,
                write: () => {},
                resize: () => {},
                kill: () => {
                  for (const listener of exitListeners) {
                    listener({ exitCode: 0, signal: null });
                  }
                },
                onData: () => () => {},
                onExit: (listener) => {
                  exitListeners.add(listener);
                  return () => {
                    exitListeners.delete(listener);
                  };
                },
              };
            }),
        });

        const projL1 = ProjectId.make("proj-term-l1");
        const projL0 = ProjectId.make("proj-term-l0");

        const manager = yield* TerminalManager.makeWithOptions({
          logsDir: NodePath.join(baseDir, "logs"),
          ptyAdapter: fakePtyAdapter,
          shellResolver: () => "/bin/bash",
          processKillGraceMs: 0,
          subprocessInspector: () =>
            Effect.succeed({ hasRunningSubprocess: false, childCommand: null, processIds: [] }),
          env: {
            PATH: "/usr/bin:/bin",
            LANG: "C.UTF-8",
            HOME: "/home/host-owner",
            HOST_SECRET_KEY: "must-not-leak-to-l1",
          },
          resolveProjectIsolation: (projectId) =>
            Effect.succeed(
              projectId === projL1
                ? Option.some({
                    projectId: projL1,
                    level: 1 as const,
                    serviceUser: "svc-term-123456",
                    serviceGroup: "t3-term-123456",
                    serviceHome: "/home/svc-term-123456",
                    workspaceRoot: workspace,
                    worktreesDir: NodePath.join(baseDir, "worktrees", projL1),
                    stateDir: NodePath.join(baseDir, "userdata", "projects", projL1),
                    portsFrom: 20_000,
                    portsTo: 20_099,
                    useSudo: false,
                  })
                : Option.none(),
            ),
          disableDiskLogs: true,
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              NodeServices.layer,
              ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
              Layer.succeed(HostProcess.Platform, "linux"),
              Layer.succeed(HostProcess.Architecture, "x64"),
              Layer.succeed(HostProcess.HomeDirectory, "/home/host-owner"),
              Layer.succeed(SpawnExecutableResolution, async (cmd) => cmd),
            ),
          ),
        );

        yield* manager.open({
          threadId: "thread-l1",
          terminalId: "default",
          cwd: workspace,
          env: {
            T3_PROJECT_ID: projL1,
            T3_MEMBER_ID: PrincipalId.make("member-1"),
            UNTRUSTED_VAR: "should-be-dropped",
          },
        });

        yield* manager.open({
          threadId: "thread-l0",
          terminalId: "default",
          cwd: workspace,
          env: {
            T3_PROJECT_ID: projL0,
          },
        });

        assert.equal(spawnCalls.length, 2);

        const l1Spawn = spawnCalls[0]!;
        assert.equal(l1Spawn.shell, "systemd-run");
        assert.include(l1Spawn.args ?? [], "--scope");
        assert.include(l1Spawn.args ?? [], "--uid=svc-term-123456");
        assert.include(l1Spawn.args ?? [], "--gid=t3-term-123456");
        assert.equal(l1Spawn.env.HOME, "/home/svc-term-123456");
        assert.equal(l1Spawn.env.T3_PROJECT_ID, projL1);
        assert.equal(l1Spawn.env.T3_MEMBER_ID, "member-1");
        assert.isUndefined(l1Spawn.env.HOST_SECRET_KEY);
        assert.isUndefined(l1Spawn.env.UNTRUSTED_VAR);

        const l0Spawn = spawnCalls[1]!;
        assert.equal(l0Spawn.shell, "/bin/bash");
        assert.equal(l0Spawn.env.HOST_SECRET_KEY, "must-not-leak-to-l1");
      }),
  );

  it.effect("CLI `t3 project isolation <id> --level 0|1` dispatches project.update mutation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-iso-cli-" });
      const baseDir = NodePath.join(root, "state");
      const workspaceRoot = NodePath.join(root, "workspace");
      yield* fs.makeDirectory(workspaceRoot);
      yield* persistServerRuntimeState({
        path: NodePath.join(baseDir, "userdata", "server-runtime.json"),
        state: yield* makePersistedServerRuntimeState({
          config: { host: "127.0.0.1", devUrl: undefined },
          port: 3_773,
        }),
      });
      const now = "2026-01-01T00:00:00.000Z";
      const receivedPayloads: Array<Record<string, unknown>> = [];
      const fetch: typeof globalThis.fetch = async (_input, init) => {
        if (init?.method === "POST") {
          const parsed = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
          receivedPayloads.push(parsed);
          return Response.json({
            id: "proj-live-1",
            title: "LiveProj",
            workspaceRoot,
            defaultModelSelection: null,
            scripts: [],
            isolationLevel: parsed.isolationLevel,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          });
        }
        return Response.json({
          projects: [
            {
              id: "proj-live-1",
              title: "LiveProj",
              workspaceRoot,
              defaultModelSelection: null,
              scripts: [],
              isolationLevel: 0,
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
            },
          ],
          updatedAt: now,
        });
      };

      const runCli = (args: ReadonlyArray<string>) =>
        Command.runWith(cli, { version: "0.0.0" })(args).pipe(
          Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer)),
          Effect.provideService(FetchHttpClient.Fetch, fetch),
        );

      yield* runCli(["project", "isolation", "proj-live-1", "--level", "1", "--base-dir", baseDir]);
      yield* runCli(["project", "isolation", "proj-live-1", "--level", "0", "--base-dir", baseDir]);

      assert.equal(receivedPayloads.length, 2);
      assert.equal(receivedPayloads[0]?.type, "project.update");
      assert.equal(receivedPayloads[0]?.projectId, "proj-live-1");
      assert.equal(receivedPayloads[0]?.isolationLevel, 1);
      assert.equal(receivedPayloads[1]?.isolationLevel, 0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

const hasGetentAndSudo = (() => {
  const getent = NodeChildProcess.spawnSync("getent", ["passwd", "root"], { stdio: "ignore" });
  if (getent.status !== 0) return false;
  const sudo = NodeChildProcess.spawnSync("sudo", ["-n", "true"], { stdio: "ignore" });
  return sudo.status === 0;
})();

describe.skipIf(!hasGetentAndSudo)(
  "ProjectIsolation Linux OS integration (non-destructive)",
  () => {
    it.effect("parses real getent passwd, getent group, and stat output on this Linux host", () =>
      Effect.gen(function* () {
        const runner = yield* ProcessRunner.ProcessRunner;
        const passwdRes = yield* runner.run({ command: "getent", args: ["passwd", "root"] });
        assert.equal(passwdRes.code, 0);
        const rootPasswd = ProjectIsolation.parseGetentPasswd(passwdRes.stdout);
        assert.isNotNull(rootPasswd);
        assert.equal(rootPasswd?.username, "root");
        assert.equal(rootPasswd?.uid, 0);

        const groupRes = yield* runner.run({ command: "getent", args: ["group", "root"] });
        assert.equal(groupRes.code, 0);
        const rootGroup = ProjectIsolation.parseGetentGroup(groupRes.stdout);
        assert.isNotNull(rootGroup);
        assert.equal(rootGroup?.groupName, "root");

        const tmpDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-iso-stat-"));
        try {
          NodeFS.chmodSync(tmpDir, 0o700);
          const statRes = yield* runner.run({
            command: "stat",
            args: ["-c", "%U %G %a", tmpDir],
          });
          assert.equal(statRes.code, 0);
          const parsedStat = ProjectIsolation.parseStatOwnerMode(statRes.stdout);
          assert.isNotNull(parsedStat);
          assert.equal(parsedStat?.modeOctal, "700");
          assert.isFalse(ProjectIsolation.isGroupRwsMode(parsedStat!.modeOctal));
        } finally {
          NodeFS.rmSync(tmpDir, { recursive: true, force: true });
        }
      }).pipe(Effect.provide(ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)))),
    );
  },
);
