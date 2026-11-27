import { describe, expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  ORCHESTRATION_V2_WS_METHODS,
  PrincipalId,
  type ProjectCapability,
  ProjectId,
  type ProjectRole,
  ThreadId,
  WS_METHODS,
  type OrchestrationV2AppThread,
  ceilingScopes,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Memberships from "../persistence/Memberships.ts";
import * as Principals from "../persistence/Principals.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectAccess from "./ProjectAccess.ts";
import * as ResourceResolver from "./ResourceResolver.ts";

const PROJECT_ID = ProjectId.make("project-1");
const PROJECT_ID_2 = ProjectId.make("project-2");
const THREAD_ID = ThreadId.make("thread-1");
const THREAD_ID_2 = ThreadId.make("thread-2");

function makeProjectionStoreLayer(
  threads: ReadonlyMap<string, Pick<OrchestrationV2AppThread, "id" | "projectId">>,
  failWith?: ProjectionStore.ProjectionStoreV2Error,
) {
  const stub = {
    findThread: (threadId: ThreadId) =>
      failWith !== undefined
        ? Effect.fail(failWith)
        : Effect.succeed((threads.get(threadId) as OrchestrationV2AppThread | undefined) ?? null),
  } as unknown as ProjectionStore.ProjectionStoreV2Shape;

  return ResourceResolver.layer.pipe(
    Layer.provide(Layer.succeed(ProjectionStore.ProjectionStoreV2, stub)),
  );
}

describe("ResourceResolver", () => {
  describe("RPC method resource and capability matrix", () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly method: string;
      readonly payload: unknown;
      readonly resource: ResourceResolver.RpcResource | undefined;
      readonly capability: ProjectCapability | undefined;
    }> = [
      {
        name: "launchThread with projectId only",
        method: ORCHESTRATION_V2_WS_METHODS.launchThread,
        payload: { projectId: PROJECT_ID, title: "New thread" },
        resource: { projectId: PROJECT_ID },
        capability: "project:thread.operate",
      },
      {
        name: "launchThread with projectId and threadId",
        method: ORCHESTRATION_V2_WS_METHODS.launchThread,
        payload: { projectId: PROJECT_ID, threadId: THREAD_ID, title: "Reuse thread" },
        resource: { projectId: PROJECT_ID, threadId: THREAD_ID },
        capability: "project:thread.operate",
      },
      {
        name: "dispatchCommand message.dispatch",
        method: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
        payload: { type: "message.dispatch", threadId: THREAD_ID },
        resource: { threadId: THREAD_ID },
        capability: "project:thread.operate",
      },
      {
        name: "dispatchCommand thread.create carries projectId and threadId",
        method: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
        payload: { type: "thread.create", projectId: PROJECT_ID, threadId: THREAD_ID },
        resource: { projectId: PROJECT_ID, threadId: THREAD_ID },
        capability: "project:thread.operate",
      },
      {
        name: "dispatchCommand thread.archive requires thread.manage",
        method: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
        payload: { type: "thread.archive", threadId: THREAD_ID },
        resource: { threadId: THREAD_ID },
        capability: "project:thread.manage",
      },
      {
        name: "dispatchCommand thread.delete requires thread.manage",
        method: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
        payload: { type: "thread.delete", threadId: THREAD_ID },
        resource: { threadId: THREAD_ID },
        capability: "project:thread.manage",
      },
      {
        name: "dispatchCommand thread.fork resolves sourceThreadId",
        method: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
        payload: { type: "thread.fork", sourceThreadId: THREAD_ID, targetThreadId: THREAD_ID_2 },
        resource: { threadId: THREAD_ID },
        capability: "project:thread.manage",
      },
      {
        name: "dispatchCommand delegated_task.request resolves parentThreadId",
        method: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
        payload: { type: "delegated_task.request", parentThreadId: THREAD_ID },
        resource: { threadId: THREAD_ID },
        capability: "project:thread.operate",
      },
      {
        name: "getThreadProjection",
        method: ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
        payload: { threadId: THREAD_ID },
        resource: { threadId: THREAD_ID },
        capability: "project:read",
      },
      {
        name: "getTurnItem",
        method: ORCHESTRATION_V2_WS_METHODS.getTurnItem,
        payload: { threadId: THREAD_ID, itemId: "item-1" },
        resource: { threadId: THREAD_ID },
        capability: "project:read",
      },
      {
        name: "subscribeThread",
        method: ORCHESTRATION_V2_WS_METHODS.subscribeThread,
        payload: { threadId: THREAD_ID },
        resource: { threadId: THREAD_ID },
        capability: "project:read",
      },
      {
        name: "subscribeShell has no single resource in payload",
        method: ORCHESTRATION_V2_WS_METHODS.subscribeShell,
        payload: { afterSequence: 0 },
        resource: undefined,
        capability: "project:read",
      },
      {
        name: "searchThreads with projectIds",
        method: ORCHESTRATION_V2_WS_METHODS.searchThreads,
        payload: { query: "bug", projectIds: [PROJECT_ID, PROJECT_ID_2] },
        resource: { projectIds: [PROJECT_ID, PROJECT_ID_2] },
        capability: "project:read",
      },
      {
        name: "searchThreads without projectIds",
        method: ORCHESTRATION_V2_WS_METHODS.searchThreads,
        payload: { query: "bug" },
        resource: undefined,
        capability: "project:read",
      },
      {
        name: "projectsMutate update requires project:settings",
        method: WS_METHODS.projectsMutate,
        payload: { type: "project.update", projectId: PROJECT_ID, title: "Renamed" },
        resource: { projectId: PROJECT_ID },
        capability: "project:settings",
      },
      {
        name: "projectsMutate create requires project:create without an existing project resource",
        method: WS_METHODS.projectsMutate,
        payload: { type: "project.create", projectId: PROJECT_ID, title: "New" },
        resource: undefined,
        capability: "project:create",
      },
      {
        name: "projectsMutate delete requires project:delete",
        method: WS_METHODS.projectsMutate,
        payload: { type: "project.delete", projectId: PROJECT_ID },
        resource: { projectId: PROJECT_ID },
        capability: "project:delete",
      },
      {
        name: "projectsReadFile maps to project:read without an explicit projectId",
        method: WS_METHODS.projectsReadFile,
        payload: { cwd: "/repo", relativePath: "README.md" },
        resource: undefined,
        capability: "project:read",
      },
      {
        name: "projectsWriteFile maps to project:file.write without an explicit projectId",
        method: WS_METHODS.projectsWriteFile,
        payload: { cwd: "/repo", relativePath: "README.md", contents: "hi" },
        resource: undefined,
        capability: "project:file.write",
      },
      {
        name: "terminalOpen carries threadId and terminalId",
        method: WS_METHODS.terminalOpen,
        payload: { threadId: THREAD_ID, terminalId: "term-1", cwd: "/repo" },
        resource: { threadId: THREAD_ID, terminalId: "term-1" },
        capability: "project:terminal.operate",
      },
      {
        name: "terminalObserve requires terminal.read",
        method: WS_METHODS.terminalObserve,
        payload: { threadId: THREAD_ID, terminalId: "term-1" },
        resource: { threadId: THREAD_ID, terminalId: "term-1" },
        capability: "project:terminal.read",
      },
      {
        name: "previewList requires project:read",
        method: WS_METHODS.previewList,
        payload: { threadId: THREAD_ID },
        resource: { threadId: THREAD_ID },
        capability: "project:read",
      },
      {
        name: "previewOpen requires project:preview.operate",
        method: WS_METHODS.previewOpen,
        payload: { threadId: THREAD_ID, url: "http://localhost:3000" },
        resource: { threadId: THREAD_ID },
        capability: "project:preview.operate",
      },
      {
        name: "secretsAnswerRequest carries threadId",
        method: WS_METHODS.secretsAnswerRequest,
        payload: { threadId: THREAD_ID, turnItemId: "item-1", answer: { type: "decline" } },
        resource: { threadId: THREAD_ID },
        capability: "project:thread.operate",
      },
      {
        name: "guestShareCreate maps to project:members",
        method: WS_METHODS.guestShareCreate,
        payload: { threadId: THREAD_ID },
        resource: { threadId: THREAD_ID },
        capability: "project:members",
      },
      {
        name: "assetsCreateUrl with workspace-file extracts nested resource.threadId",
        method: WS_METHODS.assetsCreateUrl,
        payload: { resource: { _tag: "workspace-file", threadId: THREAD_ID, path: "a.png" } },
        resource: { threadId: THREAD_ID },
        capability: "project:read",
      },
      {
        name: "pullRequestsReplyToThread uses projectId and ignores GitHub review threadId",
        method: WS_METHODS.pullRequestsReplyToThread,
        payload: { projectId: PROJECT_ID, threadId: "PRRT_githubReviewThread", body: "LGTM" },
        resource: { projectId: PROJECT_ID },
        capability: "project:source.write",
      },
      {
        name: "pullRequestsList with projectIds",
        method: WS_METHODS.pullRequestsList,
        payload: { state: "open", projectIds: [PROJECT_ID] },
        resource: { projectIds: [PROJECT_ID] },
        capability: "project:read",
      },
      {
        name: "issuesCreate uses projectId",
        method: WS_METHODS.issuesCreate,
        payload: { projectId: PROJECT_ID, scope: "org/repo", title: "Issue" },
        resource: { projectId: PROJECT_ID },
        capability: "project:source.write",
      },
      {
        name: "scheduledTasksUpsert webhook requires project:webhooks",
        method: WS_METHODS.scheduledTasksUpsert,
        payload: { projectId: PROJECT_ID, threadId: null, schedule: { type: "webhook" } },
        resource: { projectId: PROJECT_ID },
        capability: "project:webhooks",
      },
      {
        name: "serverGetSettings is environment-wide",
        method: WS_METHODS.serverGetSettings,
        payload: {},
        resource: undefined,
        capability: undefined,
      },
      {
        name: "serverUpdateSettings is environment-wide",
        method: WS_METHODS.serverUpdateSettings,
        payload: { patch: {} },
        resource: undefined,
        capability: undefined,
      },
      {
        name: "serverProbe is environment-wide",
        method: WS_METHODS.serverProbe,
        payload: {},
        resource: undefined,
        capability: undefined,
      },
      {
        name: "deviceList is environment-wide",
        method: WS_METHODS.deviceList,
        payload: {},
        resource: undefined,
        capability: undefined,
      },
    ];

    it.each(cases)("$name", ({ method, payload, resource, capability }) => {
      expect(ResourceResolver.resourcesForRpcCall(method, payload)).toEqual(resource);
      expect(ResourceResolver.capabilityForRpcCall(method, payload)).toBe(capability);
    });

    it("returns undefined for unknown methods and non-object payloads", () => {
      expect(
        ResourceResolver.resourcesForRpcCall("unknown.method", { projectId: PROJECT_ID }),
      ).toBeUndefined();
      expect(ResourceResolver.capabilityForRpcCall("unknown.method", {})).toBeUndefined();
      expect(ResourceResolver.capabilityForRpcCall("toString", {})).toBeUndefined();
      expect(
        ResourceResolver.resourcesForRpcCall(ORCHESTRATION_V2_WS_METHODS.getThreadProjection, null),
      ).toBeUndefined();
    });
  });

  describe("resolveThreadProject", () => {
    it.layer(
      makeProjectionStoreLayer(new Map([[THREAD_ID, { id: THREAD_ID, projectId: PROJECT_ID }]])),
    )("with known thread", (it) => {
      it.effect("returns projectId for an existing thread and undefined for a missing one", () =>
        Effect.gen(function* () {
          const resolver = yield* ResourceResolver.ResourceResolver;
          expect(yield* resolver.resolveThreadProject(THREAD_ID)).toBe(PROJECT_ID);
          expect(yield* resolver.resolveThreadProject(ThreadId.make("missing"))).toBeUndefined();
          expect(yield* resolver.resolveThreadProject("   ")).toBeUndefined();
        }),
      );
    });

    it.layer(
      makeProjectionStoreLayer(
        new Map(),
        new ProjectionStore.ProjectionStoreReadError({ threadId: THREAD_ID }),
      ),
    )("when ProjectionStore fails", (it) => {
      it.effect("fails closed with undefined instead of leaking errors", () =>
        Effect.gen(function* () {
          const resolver = yield* ResourceResolver.ResourceResolver;
          expect(yield* resolver.resolveThreadProject(THREAD_ID)).toBeUndefined();
        }),
      );
    });
  });

  describe("role-by-method access matrix", () => {
    const NOW = "2026-11-25T00:00:00.000Z";
    const roles: ReadonlyArray<ProjectRole> = [
      "viewer",
      "operator",
      "developer",
      "manager",
      "admin",
      "owner",
    ];
    const matrix: ReadonlyArray<{
      readonly name: string;
      readonly method: string;
      readonly payload: unknown;
      readonly allowed: ReadonlyArray<ProjectRole>;
    }> = [
      {
        name: "getThreadProjection",
        method: ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
        payload: { threadId: THREAD_ID },
        allowed: ["viewer", "operator", "developer", "manager", "admin", "owner"],
      },
      {
        name: "launchThread",
        method: ORCHESTRATION_V2_WS_METHODS.launchThread,
        payload: { projectId: PROJECT_ID, title: "Run" },
        allowed: ["operator", "developer", "manager", "admin", "owner"],
      },
      {
        name: "terminalOpen",
        method: WS_METHODS.terminalOpen,
        payload: { threadId: THREAD_ID, terminalId: "term-1", cwd: "/repo" },
        allowed: ["operator", "developer", "admin", "owner"],
      },
      {
        name: "previewOpen",
        method: WS_METHODS.previewOpen,
        payload: { threadId: THREAD_ID, url: "http://localhost:3000" },
        allowed: ["operator", "developer", "admin", "owner"],
      },
      {
        name: "projectsWriteFile",
        method: WS_METHODS.projectsWriteFile,
        payload: { cwd: "/repo", relativePath: "a.ts", contents: "" },
        allowed: ["developer", "admin", "owner"],
      },
      {
        name: "pullRequestsComment",
        method: WS_METHODS.pullRequestsComment,
        payload: { projectId: PROJECT_ID, body: "hi" },
        allowed: ["developer", "admin", "owner"],
      },
      {
        name: "dispatchCommand thread.archive",
        method: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
        payload: { type: "thread.archive", threadId: THREAD_ID },
        allowed: ["developer", "admin", "owner"],
      },
      {
        name: "projectsMutate project.create",
        method: WS_METHODS.projectsMutate,
        payload: { type: "project.create", projectId: PROJECT_ID },
        allowed: ["developer", "admin", "owner"],
      },
      {
        name: "projectsMutate project.update",
        method: WS_METHODS.projectsMutate,
        payload: { type: "project.update", projectId: PROJECT_ID },
        allowed: ["admin", "owner"],
      },
      {
        name: "guestShareCreate",
        method: WS_METHODS.guestShareCreate,
        payload: { threadId: THREAD_ID },
        allowed: ["admin", "owner"],
      },
      {
        name: "scheduledTasksUpsert webhook",
        method: WS_METHODS.scheduledTasksUpsert,
        payload: { projectId: PROJECT_ID, schedule: { type: "webhook" } },
        allowed: ["admin", "owner"],
      },
      {
        name: "projectsMutate project.delete",
        method: WS_METHODS.projectsMutate,
        payload: { type: "project.delete", projectId: PROJECT_ID },
        allowed: ["owner"],
      },
    ];

    const accessLayer = ProjectAccess.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(Principals.PrincipalRepository, {
            get: (id) => {
              const role = id.replace("role-", "") as ProjectRole;
              return Effect.succeedSome({
                id,
                kind: role === "owner" ? "owner" : "member",
                displayName: id,
                email: null,
                status: "active",
                ceiling: [...ceilingScopes("staff")],
                accessRevision: 0,
                createdAt: NOW,
                updatedAt: NOW,
                removedAt: null,
              });
            },
            getAccessStatus: () => Effect.succeedSome({ status: "active", accessRevision: 0 }),
            getByEmail: () => Effect.die("unused"),
            getOwner: Effect.die("unused"),
            countOwners: Effect.die("unused"),
            list: Effect.die("unused"),
            create: () => Effect.die("unused"),
            update: () => Effect.die("unused"),
            bumpAccessRevision: () => Effect.die("unused"),
            getEnvironmentAccessRevision: Effect.succeed(0),
            streamEnvironmentAccessRevision: Stream.empty,
            getCredential: () => Effect.die("unused"),
            setCredential: () => Effect.die("unused"),
            deleteCredential: () => Effect.die("unused"),
          }),
          Layer.succeed(Memberships.MembershipRepository, {
            get: () => Effect.die("unused"),
            listForProject: () => Effect.die("unused"),
            listForPrincipal: (principalId) => {
              const role = principalId.replace("role-", "") as ProjectRole;
              return Effect.succeed(
                role === "owner"
                  ? []
                  : [
                      {
                        projectId: PROJECT_ID,
                        principalId,
                        role,
                        state: "active",
                        invitedBy: PrincipalId.make("owner"),
                        expiresAt: null,
                        createdAt: NOW,
                        updatedAt: NOW,
                      },
                    ],
              );
            },
            upsert: () => Effect.die("unused"),
            setRole: () => Effect.die("unused"),
            setState: () => Effect.die("unused"),
            delete: () => Effect.die("unused"),
          }),
          Layer.succeed(ProjectStore.ProjectStoreV2, {
            listOwnedByPrincipal: () => Effect.succeed([]),
          } as unknown as ProjectStore.ProjectStoreV2["Service"]),
        ),
      ),
    );

    it.layer(accessLayer)("evaluates each method capability across all roles", (it) => {
      it.effect.each(matrix)("$name", ({ method, payload, allowed }) =>
        Effect.gen(function* () {
          const access = yield* ProjectAccess.ProjectAccess;
          const capability = ResourceResolver.capabilityForRpcCall(method, payload);
          expect(capability).toBeDefined();

          const permitted: ProjectRole[] = [];
          for (const role of roles) {
            const actor = yield* access.resolve({
              sessionId: AuthSessionId.make(`session-${role}`),
              subject: role,
              scopes: [...AuthStandardClientScopes],
              principalId: PrincipalId.make(`role-${role}`),
              binding: role === "owner" ? { _tag: "environment" } : { _tag: "principal" },
            });
            if (access.can(actor, PROJECT_ID, capability!)) {
              permitted.push(role);
            }
          }
          expect(permitted).toEqual(allowed);
        }),
      );
    });
  });
});
