import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProjectId,
  ROLE_SCOPES,
  ThreadId,
  ceilingScopes,
  mcpClientScopes,
  type AuthMcpClientAccess,
  type Project,
  type SessionBinding,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";

import * as ServerConfig from "../config.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import { assertClientProjectAccess, readThread } from "./threadAccess.ts";
import * as ProjectHandlers from "./toolkits/project/handlers.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";

const EPOCH = "2026-01-01T00:00:00.000Z";

const projectA = ProjectId.make("project:alpha");
const projectB = ProjectId.make("project:beta");
const threadA = ThreadId.make("thread:alpha-1");
const threadB = ThreadId.make("thread:beta-1");

const shellA = { ...liveThreadShell(threadA), projectId: projectA };
const shellB = { ...liveThreadShell(threadB), projectId: projectB };

const makeProject = (id: ProjectId, title: string): Project => ({
  id,
  title,
  workspaceRoot: `/workspace/${id}`,
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  trackedFolders: [],
  createdAt: EPOCH,
  updatedAt: EPOCH,
  deletedAt: null,
});

const projectRecordA = makeProject(projectA, "Alpha");
const projectRecordB = makeProject(projectB, "Beta");

const makeScopedClient = (input: {
  readonly access: AuthMcpClientAccess;
  readonly binding?: SessionBinding;
  readonly ceiling?: "staff" | "restricted" | "client";
}): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "client:scoped-session",
  thread: undefined,
  client: {
    sessionId: "scoped-session",
    label: "Claude Code",
    access: input.access,
    scopes: mcpClientScopes(input.access, input.ceiling),
    ...(input.binding === undefined ? {} : { binding: input.binding }),
  },
  capabilities: new Set(["orchestration", "worktree", "pull-requests"]),
  issuedAt: 0,
});

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-project-scoping-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-project-scoping-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

describe("MCP project scoping and role-equivalent scopes", () => {
  it("expands mcpClientScopes to role-equivalent scopes and intersects with ceiling", () => {
    expect(mcpClientScopes("read-only")).toEqual(ROLE_SCOPES.viewer);
    expect(mcpClientScopes("approval-required")).toEqual(ROLE_SCOPES.operator);
    expect(mcpClientScopes("auto")).toEqual(ROLE_SCOPES.developer);
    expect(mcpClientScopes("full-access")).toEqual(ROLE_SCOPES.admin);

    // Intersecting with a narrower ceiling restricts the scopes accordingly.
    expect(mcpClientScopes("auto", "restricted")).toEqual(
      ROLE_SCOPES.developer.filter((scope) => ceilingScopes("restricted").includes(scope)),
    );
    expect(mcpClientScopes("auto", "client")).toEqual(ROLE_SCOPES.viewer);
    expect(mcpClientScopes("read-only", "client")).toEqual(ROLE_SCOPES.viewer);
  });

  it.effect("refuses thread writes and reads on foreign projects and allows bound projects", () =>
    Effect.gen(function* () {
      const ProbeToolkit = Toolkit.make(
        Tool.make("write_thread", {
          parameters: Schema.Struct({ threadId: ThreadId }),
          success: Schema.Struct({ ok: Schema.Boolean }),
          failure: OrchestratorMcpFailure,
          failureMode: "return" as const,
          dependencies: [
            McpInvocationContext.McpInvocationContext,
            ThreadManagement.ThreadManagementService,
          ],
        }),
        Tool.make("read_thread", {
          parameters: Schema.Struct({ threadId: ThreadId }),
          success: Schema.Struct({ ok: Schema.Boolean }),
          failure: OrchestratorMcpFailure,
          failureMode: "return" as const,
          dependencies: [
            McpInvocationContext.McpInvocationContext,
            ThreadManagement.ThreadManagementService,
          ],
        }),
        Tool.make("write_env", {
          success: Schema.Struct({ ok: Schema.Boolean }),
          failure: OrchestratorMcpFailure,
          failureMode: "return" as const,
          dependencies: [
            McpInvocationContext.McpInvocationContext,
            ThreadManagement.ThreadManagementService,
          ],
        }),
      );

      const layerProbe = McpHttpServer.toolkitRegistration(
        ProbeToolkit,
        McpToolAccess.toLayer(ProbeToolkit, {
          write_thread: McpToolAccess.writesThreads(
            (input) => [input.threadId],
            () => Effect.succeed({ ok: true }),
          ),
          read_thread: McpToolAccess.reads((input) =>
            readThread(input.threadId).pipe(Effect.as({ ok: true })),
          ),
          write_env: McpToolAccess.writesEnvironment(() => Effect.succeed({ ok: true })),
        }),
      ).pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provideMerge(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) =>
              Effect.succeed(id === threadA ? shellA : id === threadB ? shellB : null),
            getProjectThreadRecords: (input) =>
              Effect.succeed(idleThreadProjection(input.threadId === threadA ? shellA : shellB)),
          }),
        ),
      );

      const decode = Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Union([
            Schema.Struct({ ok: Schema.Boolean }),
            Schema.Struct({ code: Schema.String }),
          ]),
        ),
      );

      const call = (
        name: string,
        scope: McpInvocationContext.McpInvocationScope,
        args: Record<string, unknown> = {},
      ) =>
        McpServer.McpServer.pipe(
          Effect.flatMap((server) => server.callTool({ name, arguments: args })),
          Effect.flatMap(({ content }) =>
            decode(content.map((part) => (part.type === "text" ? part.text : "")).join("")),
          ),
          Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
          Effect.provideService(McpSchema.McpServerClient, mcpClient),
          Effect.provide(layerProbe),
        );

      const scopedDev = makeScopedClient({
        access: "full-access",
        binding: { _tag: "projects", projects: [{ projectId: projectA, role: "developer" }] },
      });

      // Allowed project succeeds; foreign project is refused for both reads and writes.
      expect(yield* call("write_thread", scopedDev, { threadId: threadA })).toEqual({ ok: true });
      expect(yield* call("write_thread", scopedDev, { threadId: threadB })).toEqual({
        code: "capability_denied",
      });
      expect(yield* call("read_thread", scopedDev, { threadId: threadA })).toEqual({ ok: true });
      expect(yield* call("read_thread", scopedDev, { threadId: threadB })).toEqual({
        code: "capability_denied",
      });

      // Environment-wide writes are refused for project-scoped clients.
      expect(yield* call("write_env", scopedDev)).toEqual({ code: "capability_denied" });

      // Client ceiling (viewer-like) refuses writes even on an allowed project.
      const ceilingClient = makeScopedClient({
        access: "auto",
        ceiling: "client",
        binding: { _tag: "projects", projects: [{ projectId: projectA, role: "developer" }] },
      });
      expect(yield* call("write_thread", ceilingClient, { threadId: threadA })).toEqual({
        code: "capability_denied",
      });
      expect(yield* call("read_thread", ceilingClient, { threadId: threadA })).toEqual({
        ok: true,
      });

      // Viewer role on projectA refuses thread writes on projectA while allowing reads.
      const viewerClient = makeScopedClient({
        access: "read-only",
        binding: { _tag: "projects", projects: [{ projectId: projectA, role: "viewer" }] },
      });
      expect(yield* call("read_thread", viewerClient, { threadId: threadA })).toEqual({ ok: true });
      expect(yield* call("write_thread", viewerClient, { threadId: threadA })).toEqual({
        code: "capability_denied",
      });
      const denied = yield* assertClientProjectAccess(
        viewerClient,
        projectA,
        "project:thread.operate",
      ).pipe(Effect.flip);
      expect(denied.code).toBe("capability_denied");
    }),
  );

  it.effect("filters t3_project_list and refuses t3_project_read on foreign projects", () =>
    Effect.gen(function* () {
      const allProjects = [projectRecordA, projectRecordB];
      const layerServer = McpHttpServer.toolkitRegistration(
        ProjectToolkit,
        ProjectHandlers.layer,
      ).pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(
          Layer.mock(ProjectService.ProjectService)({
            listPage: ({ cursor, limit, projectIds }) => {
              const filtered = allProjects.filter(
                (project) => projectIds === undefined || projectIds.has(project.id),
              );
              return Effect.succeed({
                projects: filtered.slice(cursor, cursor + limit),
                nextCursor: cursor + limit < filtered.length ? cursor + limit : null,
              });
            },
            getById: (id) =>
              Effect.succeed(
                Option.fromUndefinedOr(allProjects.find((project) => project.id === id)),
              ),
          }),
        ),
        Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
        Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
        Layer.provide(
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/workspace",
          }),
        ),
        Layer.provide(Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({})),
        Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-project-scoping-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
        Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
        Layer.provide(Layer.mock(DocumentText.DocumentText)({})),
        Layer.provide(
          Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
        ),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      );

      const scopedClient = makeScopedClient({
        access: "read-only",
        binding: { _tag: "projects", projects: [{ projectId: projectA, role: "viewer" }] },
      });

      const call = (name: string, args: Record<string, unknown> = {}) =>
        McpServer.McpServer.pipe(
          Effect.flatMap((server) => server.callTool({ name, arguments: args })),
          Effect.map(
            ({ content }) =>
              JSON.parse(
                content.map((part) => (part.type === "text" ? part.text : "")).join(""),
              ) as
                | { readonly projects: ReadonlyArray<{ readonly id: string }> }
                | { readonly id: string }
                | { readonly code: string },
          ),
          Effect.provideService(McpInvocationContext.McpInvocationContext, scopedClient),
          Effect.provideService(McpSchema.McpServerClient, mcpClient),
          Effect.provide(layerServer),
        );

      const listed = yield* call("t3_project_list");
      expect("projects" in listed && listed.projects.map((p) => p.id)).toEqual([projectA]);

      const readAllowed = yield* call("t3_project_read", { projectId: projectA });
      expect("id" in readAllowed && readAllowed.id).toBe(projectA);

      const readForeign = yield* call("t3_project_read", { projectId: projectB });
      expect(readForeign).toMatchObject({ code: "capability_denied" });
    }),
  );
});
