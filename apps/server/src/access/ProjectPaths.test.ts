import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  EventId,
  PrincipalId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type Principal,
  type ProjectMembership,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Memberships from "../persistence/Memberships.ts";
import * as Principals from "../persistence/Principals.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectAccess from "./ProjectAccess.ts";
import * as ProjectPaths from "./ProjectPaths.ts";

const NOW = "2026-11-25T00:00:00.000Z";
const NOW_DT = DateTime.makeUnsafe(NOW);
const SESSION_ID = AuthSessionId.make("paths-session");
const OWNER_ID = PrincipalId.make("principal-owner");
const DEV_ID = PrincipalId.make("principal-dev");
const VIEWER_ID = PrincipalId.make("principal-viewer");
const PROJECT_A = ProjectId.make("project-a");
const PROJECT_B = ProjectId.make("project-b");
const PROJECT_NESTED = ProjectId.make("project-nested");
const PROJECT_C = ProjectId.make("project-c");

function makeProjectShell(input: {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly trackedFolders?: ReadonlyArray<{ readonly path: string; readonly name: string }>;
}): OrchestrationProjectShell {
  return {
    id: input.id,
    title: input.title,
    hasCustomTitle: false,
    workspaceRoot: input.workspaceRoot,
    repositoryIdentity: null,
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
    autoPull: false,
    faviconPath: null,
    projectIcon: null,
    scripts: [],
    trackedFolders: [...(input.trackedFolders ?? [])],
    pinnedAt: null,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makePrincipal(overrides: Partial<Principal> & Pick<Principal, "id" | "kind">): Principal {
  return {
    displayName: overrides.id,
    email: null,
    status: "active",
    ceiling: [...AuthStandardClientScopes],
    accessRevision: 0,
    createdAt: NOW,
    updatedAt: NOW,
    removedAt: null,
    ...overrides,
  };
}

function makeMembership(
  overrides: Partial<ProjectMembership> &
    Pick<ProjectMembership, "projectId" | "principalId" | "role">,
): ProjectMembership {
  return {
    state: "active",
    invitedBy: OWNER_ID,
    expiresAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeFixtureLayer(options: {
  readonly worktreesDir: string;
  readonly getShells: () => ReadonlyArray<OrchestrationProjectShell>;
  readonly onListShells?: () => void;
  readonly principals?: ReadonlyArray<Principal>;
  readonly memberships?: ReadonlyArray<ProjectMembership>;
}) {
  const principalMap = new Map((options.principals ?? []).map((p) => [p.id, p]));
  const membershipList = options.memberships ?? [];

  const principalRepo = Layer.succeed(Principals.PrincipalRepository, {
    get: (id) => Effect.succeed(Option.fromNullishOr(principalMap.get(id))),
    getAccessStatus: (id) => {
      const principal = principalMap.get(id);
      return Effect.succeed(
        principal === undefined
          ? Option.none()
          : Option.some({
              status: principal.status,
              accessRevision: principal.accessRevision,
            }),
      );
    },
    getByEmail: () => Effect.die("unused"),
    list: Effect.succeed([...principalMap.values()]),
    create: () => Effect.die("unused"),
    update: () => Effect.die("unused"),
    bumpAccessRevision: () => Effect.die("unused"),
    getEnvironmentAccessRevision: Effect.succeed(0),
    streamEnvironmentAccessRevision: Stream.empty,
    getCredential: () => Effect.die("unused"),
    setCredential: () => Effect.die("unused"),
    deleteCredential: () => Effect.die("unused"),
  });

  const membershipRepo = Layer.succeed(Memberships.MembershipRepository, {
    get: () => Effect.die("unused"),
    listForProject: () => Effect.die("unused"),
    listForPrincipal: (principalId) =>
      Effect.succeed(membershipList.filter((m) => m.principalId === principalId)),
    upsert: () => Effect.die("unused"),
    setRole: () => Effect.die("unused"),
    setState: () => Effect.die("unused"),
    delete: () => Effect.die("unused"),
  });

  const projectStore = Layer.succeed(ProjectStore.ProjectStoreV2, {
    apply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
    findActiveByWorkspaceRoot: () => Effect.die("unused"),
    getShell: () => Effect.die("unused"),
    listShells: () =>
      Effect.sync(() => {
        options.onListShells?.();
        return options.getShells();
      }),
    setOwnership: () => Effect.die("unused"),
    listOwnedByPrincipal: () => Effect.succeed([]),
  });

  const accessLayer = ProjectAccess.layer.pipe(
    Layer.provide(Layer.mergeAll(principalRepo, membershipRepo, projectStore)),
  );

  const sqlLayer = SqlitePersistence.layerMemory;

  const configLayer = Layer.mock(ServerConfig.ServerConfig)({
    worktreesDir: options.worktreesDir,
  } as ServerConfig.ServerConfig["Service"]);

  const pathsLayer = ProjectPaths.layer.pipe(
    Layer.provide(
      Layer.mergeAll(accessLayer, projectStore, configLayer, sqlLayer, NodeServices.layer),
    ),
  );

  return Layer.mergeAll(accessLayer, pathsLayer, sqlLayer, NodeServices.layer);
}

describe("ProjectPaths", () => {
  it.effect(
    "validates inside root, nested roots, worktree paths, symlinks, '..' traversal, non-existent leaves, and owner bypass",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const base = yield* fs.makeTempDirectoryScoped({ prefix: "t3-project-paths-" });

        const rootA = path.join(base, "project-a");
        const nestedRoot = path.join(rootA, "packages", "secret-nested");
        const rootB = path.join(base, "project-b");
        const worktreesDir = path.join(base, "worktrees");
        const worktreeById = path.join(worktreesDir, PROJECT_A, "feat-1");
        const worktreeByRepo = path.join(worktreesDir, "project-a", "feat-2");
        const foreignWorktree = path.join(worktreesDir, PROJECT_B, "secret-branch");
        const unknownDir = path.join(base, "outside");

        yield* fs.makeDirectory(path.join(rootA, "src"), { recursive: true });
        yield* fs.makeDirectory(nestedRoot, { recursive: true });
        yield* fs.makeDirectory(path.join(rootB, "private"), { recursive: true });
        yield* fs.makeDirectory(worktreeById, { recursive: true });
        yield* fs.makeDirectory(worktreeByRepo, { recursive: true });
        yield* fs.makeDirectory(foreignWorktree, { recursive: true });
        yield* fs.makeDirectory(unknownDir, { recursive: true });

        const fileInA = path.join(rootA, "src", "index.ts");
        const fileInNested = path.join(nestedRoot, "secret.ts");
        const fileInB = path.join(rootB, "private", "keys.txt");
        const fileInWorktreeById = path.join(worktreeById, "app.ts");
        const fileInWorktreeByRepo = path.join(worktreeByRepo, "app.ts");
        const fileInForeignWorktree = path.join(foreignWorktree, "secret.ts");
        const fileOutside = path.join(unknownDir, "notes.txt");

        yield* fs.writeFileString(fileInA, "export const ok = true;\n");
        yield* fs.writeFileString(fileInNested, "top secret\n");
        yield* fs.writeFileString(fileInB, "secret key\n");
        yield* fs.writeFileString(fileInWorktreeById, "worktree by id\n");
        yield* fs.writeFileString(fileInWorktreeByRepo, "worktree by repo\n");
        yield* fs.writeFileString(fileInForeignWorktree, "foreign worktree\n");
        yield* fs.writeFileString(fileOutside, "host file\n");

        // Symlink inside project-a escaping to foreign project-b (file, directory, and dangling link).
        const escapeFileLink = path.join(rootA, "src", "escape-file");
        const escapeDirLink = path.join(rootA, "src", "escape-dir");
        const danglingEscapeLink = path.join(rootA, "src", "dangling-escape");
        yield* fs.symlink(fileInB, escapeFileLink);
        yield* fs.symlink(rootB, escapeDirLink);
        yield* fs.symlink(path.join(rootB, "private", "future.txt"), danglingEscapeLink);

        const shells = [
          makeProjectShell({ id: PROJECT_A, title: "Project A", workspaceRoot: rootA }),
          makeProjectShell({
            id: PROJECT_NESTED,
            title: "Nested Secret",
            workspaceRoot: nestedRoot,
          }),
          makeProjectShell({ id: PROJECT_B, title: "Project B", workspaceRoot: rootB }),
        ];

        const fixture = makeFixtureLayer({
          worktreesDir,
          getShells: () => shells,
          principals: [
            makePrincipal({ id: OWNER_ID, kind: "owner", ceiling: [] }),
            makePrincipal({ id: DEV_ID, kind: "member" }),
            makePrincipal({ id: VIEWER_ID, kind: "member" }),
          ],
          memberships: [
            makeMembership({ projectId: PROJECT_A, principalId: DEV_ID, role: "developer" }),
            makeMembership({ projectId: PROJECT_A, principalId: VIEWER_ID, role: "viewer" }),
          ],
        });

        yield* Effect.gen(function* () {
          const access = yield* ProjectAccess.ProjectAccess;
          const projectPaths = yield* ProjectPaths.ProjectPaths;

          const owner = yield* access.resolve({
            sessionId: SESSION_ID,
            subject: "owner",
            scopes: [...AuthStandardClientScopes],
            principalId: OWNER_ID,
            binding: { _tag: "environment" },
          });
          const dev = yield* access.resolve({
            sessionId: SESSION_ID,
            subject: "dev",
            scopes: [...AuthStandardClientScopes],
            principalId: DEV_ID,
            binding: { _tag: "principal" },
          });
          const viewer = yield* access.resolve({
            sessionId: SESSION_ID,
            subject: "viewer",
            scopes: [...AuthStandardClientScopes],
            principalId: VIEWER_ID,
            binding: { _tag: "principal" },
          });

          // 1. Inside root (file + cwd) succeeds for developer and viewer on read.
          const resolvedA = yield* projectPaths.assertPath(dev, fileInA, "project:read");
          expect(resolvedA.projectId).toBe(PROJECT_A);
          expect(resolvedA.realPath).toBe(yield* fs.realPath(fileInA));

          const resolvedCwdA = yield* projectPaths.assertCwd(dev, rootA, "project:file.write");
          expect(resolvedCwdA.projectId).toBe(PROJECT_A);

          // Viewer can read inside rootA, but lacks project:file.write.
          yield* projectPaths.assertPath(viewer, fileInA, "project:read");
          const viewerWriteDenied = yield* projectPaths
            .assertPath(viewer, fileInA, "project:file.write")
            .pipe(Effect.flip);
          expect(viewerWriteDenied).toMatchObject({
            _tag: "project_forbidden",
            projectId: PROJECT_A,
            requiredPermission: "project:file.write",
          });

          // 2. Nested project root: longest matching root wins (PROJECT_NESTED shadows PROJECT_A).
          const nestedDenied = yield* projectPaths
            .assertPath(dev, fileInNested, "project:read")
            .pipe(Effect.flip);
          expect(nestedDenied).toMatchObject({
            _tag: "project_forbidden",
            projectId: PROJECT_NESTED,
            requiredPermission: "project:read",
          });

          // 3. Worktree paths under worktreesDir (both <projectId> and unique <repoName>).
          const wtById = yield* projectPaths.assertPath(
            dev,
            fileInWorktreeById,
            "project:terminal.operate",
          );
          expect(wtById.projectId).toBe(PROJECT_A);
          const wtByRepo = yield* projectPaths.assertCwd(
            dev,
            worktreeByRepo,
            "project:terminal.operate",
          );
          expect(wtByRepo.projectId).toBe(PROJECT_A);
          expect(
            (yield* projectPaths.assertPath(dev, fileInWorktreeByRepo, "project:read")).projectId,
          ).toBe(PROJECT_A);

          const foreignWtDenied = yield* projectPaths
            .assertPath(dev, fileInForeignWorktree, "project:read")
            .pipe(Effect.flip);
          expect(foreignWtDenied).toMatchObject({
            _tag: "project_forbidden",
            projectId: PROJECT_B,
            requiredPermission: "project:read",
          });

          // 4. Symlink escaping to a foreign project (existing file, dir + new leaf, dangling link).
          for (const escaped of [
            escapeFileLink,
            path.join(escapeDirLink, "private", "new-file.txt"),
            danglingEscapeLink,
          ]) {
            const symlinkDenied = yield* projectPaths
              .assertPath(dev, escaped, "project:file.write")
              .pipe(Effect.flip);
            expect(symlinkDenied).toMatchObject({
              _tag: "project_forbidden",
              projectId: PROJECT_B,
              requiredPermission: "project:file.write",
            });
          }

          // 5. ".." traversal escaping to a foreign project (existing and non-existent leaf).
          const dotDotExisting = yield* projectPaths
            .assertPath(
              dev,
              path.join(rootA, "src", "..", "..", "project-b", "private", "keys.txt"),
              "project:read",
            )
            .pipe(Effect.flip);
          expect(dotDotExisting).toMatchObject({
            _tag: "project_forbidden",
            projectId: PROJECT_B,
            requiredPermission: "project:read",
          });

          const dotDotMissing = yield* projectPaths
            .assertPath(
              dev,
              path.join(rootA, "no-such-dir", "..", "..", "project-b", "private", "future.txt"),
              "project:file.write",
            )
            .pipe(Effect.flip);
          expect(dotDotMissing).toMatchObject({
            _tag: "project_forbidden",
            projectId: PROJECT_B,
            requiredPermission: "project:file.write",
          });

          // 6. Non-existent leaf inside accessible project succeeds; outside all projects fails with project:read + distinct message.
          const newNestedFile = path.join(rootA, "new-dir", "deep", "file.ts");
          const resolvedNew = yield* projectPaths.assertPath(
            dev,
            newNestedFile,
            "project:file.write",
          );
          expect(resolvedNew.projectId).toBe(PROJECT_A);
          expect(resolvedNew.realPath).toBe(
            path.join(yield* fs.realPath(rootA), "new-dir", "deep", "file.ts"),
          );

          const foreignMissing = yield* projectPaths
            .assertPath(dev, path.join(rootB, "new-dir", "file.ts"), "project:file.write")
            .pipe(Effect.flip);
          expect(foreignMissing).toMatchObject({
            _tag: "project_forbidden",
            projectId: PROJECT_B,
            requiredPermission: "project:file.write",
          });

          // Path matching nothing => project:read with a distinct message reason from foreign project errors.
          const unknownDenied = yield* projectPaths
            .assertPath(dev, fileOutside, "project:file.write")
            .pipe(Effect.flip);
          expect(unknownDenied).toMatchObject({
            _tag: "project_forbidden",
            projectId: ProjectId.make("environment"),
            requiredPermission: "project:read",
          });
          expect(unknownDenied.message).not.toBe(foreignMissing.message);
          expect(unknownDenied.message).toContain("outside");

          // 7. Owner / environment binding passes unknown paths, non-existent paths, and any project root.
          const ownerUnknown = yield* projectPaths.assertPath(owner, fileOutside, "project:read");
          expect(ownerUnknown.realPath).toBe(yield* fs.realPath(fileOutside));
          expect(ownerUnknown.projectId).toBeUndefined();

          const ownerMissing = yield* projectPaths.assertPath(
            owner,
            path.join(unknownDir, "does-not-exist", "file.txt"),
            "project:file.write",
          );
          expect(ownerMissing.realPath).toBe(
            path.join(yield* fs.realPath(unknownDir), "does-not-exist", "file.txt"),
          );

          const ownerInProject = yield* projectPaths.assertPath(
            owner,
            fileInB,
            "project:terminal.operate",
          );
          expect(ownerInProject.realPath).toBe(yield* fs.realPath(fileInB));
        }).pipe(Effect.provide(fixture));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("resolves thread worktrees stored in SQLite for their owning project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fs.makeTempDirectoryScoped({ prefix: "t3-project-paths-wt-" });
      const rootA = path.join(base, "dup-a", "app");
      const rootB = path.join(base, "dup-b", "app");
      const worktreesDir = path.join(base, "worktrees");
      const threadWorktreeA = path.join(base, "custom-worktrees", "wt-a");
      const threadWorktreeB = path.join(base, "custom-worktrees", "wt-b");

      yield* fs.makeDirectory(rootA, { recursive: true });
      yield* fs.makeDirectory(rootB, { recursive: true });
      yield* fs.makeDirectory(worktreesDir, { recursive: true });
      yield* fs.makeDirectory(threadWorktreeA, { recursive: true });
      yield* fs.makeDirectory(threadWorktreeB, { recursive: true });

      const shells = [
        makeProjectShell({ id: PROJECT_A, title: "App A", workspaceRoot: rootA }),
        makeProjectShell({ id: PROJECT_B, title: "App B", workspaceRoot: rootB }),
      ];

      const fixture = makeFixtureLayer({
        worktreesDir,
        getShells: () => shells,
        principals: [makePrincipal({ id: DEV_ID, kind: "member" })],
        memberships: [
          makeMembership({ projectId: PROJECT_A, principalId: DEV_ID, role: "developer" }),
        ],
      });

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const access = yield* ProjectAccess.ProjectAccess;
        const projectPaths = yield* ProjectPaths.ProjectPaths;
        const sink = yield* EventSink.EventSinkV2;

        const seedThread = (threadId: ThreadId, projectId: ProjectId, worktreePath: string) =>
          sink.write({
            events: [
              {
                id: EventId.make(`create:${threadId}`),
                type: "thread.created",
                threadId,
                occurredAt: NOW_DT,
                payload: {
                  id: threadId,
                  projectId,
                  title: "wt",
                  providerInstanceId: ProviderInstanceId.make("codex"),
                  modelSelection: {
                    instanceId: ProviderInstanceId.make("codex"),
                    model: "gpt-5.4",
                  },
                  runtimeMode: "auto",
                  interactionMode: "default",
                  branch: "feat",
                  worktreePath,
                  activeProviderThreadId: null,
                  lineage: {
                    rootThreadId: threadId,
                    parentThreadId: null,
                    relationshipToParent: null,
                  },
                  forkedFrom: null,
                  createdBy: "user",
                  creationSource: "web",
                  createdAt: NOW_DT,
                  updatedAt: NOW_DT,
                  archivedAt: null,
                  settledOverride: null,
                  settledAt: null,
                  lastVisitedAt: null,
                  deletedAt: null,
                },
              },
            ],
          });

        yield* seedThread(ThreadId.make("thread-a"), PROJECT_A, threadWorktreeA);
        yield* seedThread(ThreadId.make("thread-b"), PROJECT_B, threadWorktreeB);
        // Sanity check rows exist.
        const count = yield* sql<{ readonly n: number }>`
          SELECT COUNT(*) AS "n" FROM orchestration_v2_projection_threads
        `;
        expect(count[0]?.n).toBe(2);

        const dev = yield* access.resolve({
          sessionId: SESSION_ID,
          subject: "dev",
          scopes: [...AuthStandardClientScopes],
          principalId: DEV_ID,
          binding: { _tag: "principal" },
        });

        // Accessible thread worktree passes.
        const allowed = yield* projectPaths.assertCwd(dev, threadWorktreeA, "project:read");
        expect(allowed.projectId).toBe(PROJECT_A);

        // Foreign thread worktree is refused with project B's id and requested capability.
        const denied = yield* projectPaths
          .assertCwd(dev, threadWorktreeB, "project:terminal.operate")
          .pipe(Effect.flip);
        expect(denied).toMatchObject({
          _tag: "project_forbidden",
          projectId: PROJECT_B,
          requiredPermission: "project:terminal.operate",
        });

        // Duplicate repo basename ("app") must NOT grant blanket access to worktreesDir/app.
        const ambiguousDir = path.join(worktreesDir, "app", "other-branch");
        const ambiguousDenied = yield* projectPaths
          .assertPath(dev, ambiguousDir, "project:read")
          .pipe(Effect.flip);
        expect(ambiguousDenied).toMatchObject({
          _tag: "project_forbidden",
          projectId: ProjectId.make("environment"),
          requiredPermission: "project:read",
        });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            fixture,
            EventSink.layer.pipe(
              Layer.provide(
                Layer.mergeAll(EventStore.layer, ProjectionStore.layer, ProjectStore.layer),
              ),
              Layer.provide(fixture),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "caches the root list per actor accessRevision and rebuilds when accessRevision bumps",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const base = yield* fs.makeTempDirectoryScoped({ prefix: "t3-project-paths-cache-" });

        const rootA = path.join(base, "project-a");
        const rootC = path.join(base, "project-c");
        const worktreesDir = path.join(base, "worktrees");
        yield* fs.makeDirectory(rootA, { recursive: true });
        yield* fs.makeDirectory(rootC, { recursive: true });
        yield* fs.makeDirectory(worktreesDir, { recursive: true });

        let shells: ReadonlyArray<OrchestrationProjectShell> = [
          makeProjectShell({ id: PROJECT_A, title: "Project A", workspaceRoot: rootA }),
        ];
        let listShellsCalls = 0;

        const fixture = makeFixtureLayer({
          worktreesDir,
          getShells: () => shells,
          onListShells: () => {
            listShellsCalls += 1;
          },
          principals: [makePrincipal({ id: DEV_ID, kind: "member", accessRevision: 0 })],
          memberships: [
            makeMembership({ projectId: PROJECT_A, principalId: DEV_ID, role: "developer" }),
          ],
        });

        yield* Effect.gen(function* () {
          const projectPaths = yield* ProjectPaths.ProjectPaths;
          const actorRev0: ProjectAccess.AccessActor = {
            sessionId: SESSION_ID,
            subject: "dev",
            scopes: [...AuthStandardClientScopes],
            principalId: DEV_ID,
            binding: { _tag: "principal" },
            isOwner: false,
            accessRevision: 0,
            roles: new Map([[PROJECT_A, "developer"]]),
          };

          // First call populates the cache for revision 0.
          yield* projectPaths.assertCwd(actorRev0, rootA, "project:read");
          expect(listShellsCalls).toBe(1);

          // Subsequent calls at the same revision hit the cache.
          yield* projectPaths.assertPath(actorRev0, path.join(rootA, "file.ts"), "project:read");
          yield* projectPaths.assertCwd(actorRev0, rootA, "project:file.write");
          expect(listShellsCalls).toBe(1);

          // Add project C to store; revision 0 actor still sees the cached snapshot.
          shells = [
            ...shells,
            makeProjectShell({ id: PROJECT_C, title: "Project C", workspaceRoot: rootC }),
          ];
          const staleDenied = yield* projectPaths
            .assertCwd(actorRev0, rootC, "project:read")
            .pipe(Effect.flip);
          expect(staleDenied._tag).toBe("project_forbidden");
          expect(listShellsCalls).toBe(1);

          // Bumping accessRevision invalidates the cache and rebuilds the root list.
          const actorRev1: ProjectAccess.AccessActor = {
            ...actorRev0,
            accessRevision: 1,
            roles: new Map([
              [PROJECT_A, "developer"],
              [PROJECT_C, "developer"],
            ]),
          };
          const resolvedC = yield* projectPaths.assertCwd(actorRev1, rootC, "project:read");
          expect(resolvedC.projectId).toBe(PROJECT_C);
          expect(listShellsCalls).toBe(2);

          // Repeated calls at revision 1 hit the rebuilt cache.
          yield* projectPaths.assertPath(actorRev1, path.join(rootC, "index.ts"), "project:read");
          expect(listShellsCalls).toBe(2);
        }).pipe(Effect.provide(fixture));
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
