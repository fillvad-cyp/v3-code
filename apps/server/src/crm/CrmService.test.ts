import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import {
  AuthAdministrativeClientScopes,
  AuthSessionId,
  CRM_REDACTED_PLACEHOLDER,
  type CrmClient,
  type CrmClientDetail,
  type CrmClientInviteResult,
  type CrmClientThread,
  type CrmContact,
  type CrmNote,
  EnvironmentHttpApi,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationProjectShell,
  type OrchestrationV2AppThread,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
  PrincipalId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ceilingScopes,
  roleScopes,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as ProjectAccess from "../access/ProjectAccess.ts";
import * as ResourceResolver from "../access/ResourceResolver.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as AuthHttp from "../auth/http.ts";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as InvitationService from "../identity/InvitationService.ts";
import * as MembershipService from "../identity/MembershipService.ts";
import * as PrincipalLimitsService from "../identity/PrincipalLimitsService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as OrchestrationHttp from "../orchestration-v2/http.ts";
import { filterShellSnapshot, filterShellStreamItem } from "../orchestration-v2/ShellStream.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ApiTokens from "../persistence/ApiTokens.ts";
import * as AuditEvents from "../persistence/AuditEvents.ts";
import * as CrmRepo from "../persistence/Crm.ts";
import * as Invitations from "../persistence/Invitations.ts";
import * as MemberLimits from "../persistence/MemberLimits.ts";
import * as Memberships from "../persistence/Memberships.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as Principals from "../persistence/Principals.ts";
import * as RecoveryCodes from "../persistence/RecoveryCodes.ts";
import * as SessionPrincipals from "../persistence/SessionPrincipals.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ProjectEnrichment from "../project/ProjectEnrichmentService.ts";
import * as ProjectQuotaService from "../project/ProjectQuotaService.ts";
import * as ProjectSecrets from "../project/ProjectSecrets.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CrmService from "./CrmService.ts";
import * as CrmHttp from "./http.ts";

const OWNER_ID = PrincipalId.make("owner");
const MANAGER_ID = PrincipalId.make("member-manager");
const ADMIN_ID = PrincipalId.make("member-admin");
const DEVELOPER_ID = PrincipalId.make("member-developer");
const VIEWER_ID = PrincipalId.make("member-viewer");
const OUTSIDER_ID = PrincipalId.make("member-outsider");

const PROJECT_A = ProjectId.make("project-alpha");
const PROJECT_B = ProjectId.make("project-beta");
const THREAD_A_LINKED = ThreadId.make("thread-alpha-linked");
const THREAD_A_UNLINKED = ThreadId.make("thread-alpha-unlinked");
const THREAD_B = ThreadId.make("thread-beta-1");
const NOW_ISO = "2026-11-26T12:00:00.000Z";
const NOW = DateTime.makeUnsafe(NOW_ISO);
const DEV_TOKEN = "reusable-dev-auth-token-for-crm-tests";

class CrmHttpTestApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.crm)
  .add(EnvironmentHttpApi.groups.orchestration) {}

function makeThreadShell(id: ThreadId, projectId: ProjectId): OrchestrationV2ThreadShell {
  return {
    id,
    projectId,
    title: `Thread ${id}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "auto",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    lineage: {
      rootThreadId: id,
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    activeProviderThreadId: null,
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    providerInstanceHistory: [],
    itemCount: 0,
    visibleItemCount: 0,
    createdBy: "user",
    creationSource: "web",
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function makeProjectShell(id: ProjectId): OrchestrationProjectShell {
  return {
    id,
    title: `Project ${id}`,
    workspaceRoot: `/workspaces/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  };
}

const threadsById = new Map<string, Pick<OrchestrationV2AppThread, "id" | "projectId">>([
  [THREAD_A_LINKED, { id: THREAD_A_LINKED, projectId: PROJECT_A }],
  [THREAD_A_UNLINKED, { id: THREAD_A_UNLINKED, projectId: PROJECT_A }],
  [THREAD_B, { id: THREAD_B, projectId: PROJECT_B }],
]);

const makeTestLayer = () => {
  const layerConfig = Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return {
        ...config,
        mode: "web",
        devUrl: new URL("http://127.0.0.1:5173"),
        devAuthToken: Redacted.make(DEV_TOKEN),
      } satisfies ServerConfig.ServerConfig["Service"];
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-crm-" })));

  const layerIdentityRepositories = Layer.mergeAll(
    Principals.layer,
    Memberships.layer,
    Invitations.layer,
    AuditEvents.layer,
    ApiTokens.layer,
    MemberLimits.layer,
    RecoveryCodes.layer,
    SessionPrincipals.layer,
    CrmRepo.layer,
  );

  const layerProjectionStub = Layer.succeed(ProjectionStore.ProjectionStoreV2, {
    findThread: (threadId: ThreadId) =>
      Effect.succeed((threadsById.get(threadId) as OrchestrationV2AppThread | undefined) ?? null),
  } as unknown as ProjectionStore.ProjectionStoreV2Shape);

  const layerAccess = Layer.mergeAll(
    ProjectAccess.layer.pipe(
      Layer.provide(layerIdentityRepositories),
      Layer.provide(ProjectStore.layer),
    ),
    ResourceResolver.layer.pipe(Layer.provide(layerProjectionStub), Layer.provide(CrmRepo.layer)),
  );

  const layerPrincipalLimits = PrincipalLimitsService.layer.pipe(
    Layer.provide(layerIdentityRepositories),
  );

  const layerEnv = ServerEnvironment.layer.pipe(
    Layer.provide(ServerSettings.layerTest({ multiUser: true })),
  );

  const layerAuth = EnvironmentAuth.layer.pipe(
    Layer.provide(layerIdentityRepositories),
    Layer.provide(layerPrincipalLimits),
    Layer.provide(layerEnv),
    Layer.provide(ServerSettings.layerTest({ multiUser: true })),
    Layer.provide(ManagedPolicy.layer),
  );

  const layerMembership = MembershipService.layer.pipe(
    Layer.provideMerge(layerIdentityRepositories),
    Layer.provide(layerAccess),
    Layer.provide(layerAuth),
  );

  const layerInvitations = InvitationService.layer.pipe(
    Layer.provideMerge(layerIdentityRepositories),
    Layer.provide(layerMembership),
    Layer.provide(layerAccess),
  );

  const layerCrm = CrmService.layer.pipe(
    Layer.provide(CrmRepo.layer),
    Layer.provide(layerInvitations),
    Layer.provide(layerIdentityRepositories),
    Layer.provide(layerAccess),
  );

  const layerCore = Layer.mergeAll(
    layerIdentityRepositories,
    layerAccess,
    layerAuth,
    layerMembership,
    layerInvitations,
    layerCrm,
    ProjectStore.layer,
    layerEnv,
  );

  return layerCore.pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(layerConfig),
    Layer.provideMerge(PlatformNodeCrypto.layer),
    Layer.provideMerge(NodeServices.layer),
  );
};

const seedProjectsAndPrincipals = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const principals = yield* Principals.PrincipalRepository;
  const memberships = yield* Memberships.MembershipRepository;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;

  for (const projectId of [PROJECT_A, PROJECT_B]) {
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
      ) VALUES (
        ${projectId}, ${`Project ${projectId}`}, ${`/workspaces/${projectId}`}, '[]',
        ${NOW_ISO}, ${NOW_ISO}, NULL
      )
    `;
  }

  const createMember = (
    id: PrincipalId,
    displayName: string,
    role: "admin" | "manager" | "developer" | "viewer" | null,
    projects: ReadonlyArray<ProjectId> = [PROJECT_A],
  ) =>
    Effect.gen(function* () {
      yield* principals.create({
        id,
        kind: "member",
        displayName,
        email: `${id}@example.com`,
        status: "active",
        ceiling: [...ceilingScopes("staff")],
        createdAt: NOW_ISO,
      });
      if (role !== null) {
        for (const projectId of projects) {
          yield* memberships.upsert({
            projectId,
            principalId: id,
            role,
            state: "active",
            invitedBy: OWNER_ID,
            expiresAt: null,
            updatedAt: NOW_ISO,
          });
        }
      }
      const scopes = role !== null ? [...roleScopes(role)] : [...roleScopes("viewer")];
      const issued = yield* auth.issuePrincipalSession({
        principalId: id,
        binding: { _tag: "principal" },
        scopes,
        method: "bearer-access-token",
        client: { deviceType: "desktop" },
      });
      return issued.token;
    });

  const ownerIssued = yield* auth.issuePrincipalSession({
    principalId: OWNER_ID,
    binding: { _tag: "environment" },
    scopes: [...AuthAdministrativeClientScopes],
    method: "bearer-access-token",
    client: { deviceType: "desktop" },
  });
  const adminToken = yield* createMember(ADMIN_ID, "Admin", "admin", [PROJECT_A, PROJECT_B]);
  const managerToken = yield* createMember(MANAGER_ID, "Manager", "manager", [
    PROJECT_A,
    PROJECT_B,
  ]);
  const developerToken = yield* createMember(DEVELOPER_ID, "Developer", "developer", [PROJECT_A]);
  const viewerToken = yield* createMember(VIEWER_ID, "Viewer", "viewer", [PROJECT_A]);
  const outsiderToken = yield* createMember(OUTSIDER_ID, "Outsider", null, []);

  return {
    ownerToken: ownerIssued.token,
    adminToken,
    managerToken,
    developerToken,
    viewerToken,
    outsiderToken,
  };
});

const withHttpHandler = <A, E>(
  use: (
    request: (
      path: string,
      options?: { readonly method?: string; readonly token?: string; readonly body?: unknown },
    ) => Promise<{ readonly status: number; readonly text: string; readonly json: unknown }>,
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const access = yield* ProjectAccess.ProjectAccess;
    const resolver = yield* ResourceResolver.ResourceResolver;
    const crm = yield* CrmService.CrmService;
    const sql = yield* SqlClient.SqlClient;
    const envIdentity = yield* ServerEnvironment.ServerEnvironmentIdentity;

    const threadShellA1 = makeThreadShell(THREAD_A_LINKED, PROJECT_A);
    const threadShellA2 = makeThreadShell(THREAD_A_UNLINKED, PROJECT_A);
    const threadShellB = makeThreadShell(THREAD_B, PROJECT_B);
    const allThreadShells = [threadShellA1, threadShellA2, threadShellB];

    const appLayer = HttpApiBuilder.layer(CrmHttpTestApi).pipe(
      Layer.provide(CrmHttp.layer),
      Layer.provide(OrchestrationHttp.layer),
      Layer.provide(AuthHttp.layerAuthenticatedAuth),
      Layer.provide(Layer.succeed(EnvironmentAuth.EnvironmentAuth, auth)),
      Layer.provide(Layer.succeed(ProjectAccess.ProjectAccess, access)),
      Layer.provide(Layer.succeed(ResourceResolver.ResourceResolver, resolver)),
      Layer.provide(Layer.succeed(CrmService.CrmService, crm)),
      Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
      Layer.provide(Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, envIdentity)),
      Layer.provide(
        Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({
          latestApplicationSequence: Effect.succeed(1),
        }),
      ),
      Layer.provide(
        Layer.mock(ProjectStore.ProjectStoreV2)({
          listShells: (input?: { readonly projectIds?: ReadonlyArray<ProjectId> }) => {
            const all = [makeProjectShell(PROJECT_A), makeProjectShell(PROJECT_B)];
            if (input?.projectIds === undefined) return Effect.succeed(all);
            const set = new Set<string>(input.projectIds);
            return Effect.succeed(all.filter((project) => set.has(project.id)));
          },
        }),
      ),
      Layer.provide(
        Layer.mock(ProjectEnrichment.ProjectEnrichmentService)({
          getAvailable: () =>
            Effect.succeed({
              repositoryIdentity: null,
              faviconPath: null,
              repositoryIdentityResolved: false,
            }),
        }),
      ),
      Layer.provide(
        Layer.mock(ProjectQuotaService.ProjectQuotaService)({
          getWarningsForProjects: () => Effect.succeed(new Map()),
        }),
      ),
      Layer.provide(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          listActiveShellIndex: () => Effect.succeed([]),
          readShellSnapshot: () =>
            Effect.succeed(
              Effect.succeed({
                schemaVersion: 1,
                snapshotSequence: 1,
                threads: allThreadShells,
                archivedThreads: [],
              }),
            ),
          getThreadShell: (threadId: ThreadId) =>
            Effect.succeed(allThreadShells.find((entry) => entry.id === threadId) ?? null),
          getThreadTranscript: (threadId: ThreadId) =>
            Effect.succeed({
              threadId,
              title: `Transcript ${threadId}`,
              updatedAt: NOW,
              items: [],
            }),
        }),
      ),
      Layer.provide(HttpPlatform.layer),
      Layer.provide(Etag.layerWeak),
      Layer.provide(NodeServices.layer),
    );

    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(appLayer, { disableLogger: true })),
      ({ handler }) =>
        use(async (path, options = {}) => {
          const headers = new Headers();
          if (options.token !== undefined) {
            headers.set("authorization", `Bearer ${options.token}`);
          }
          if (path.startsWith("/api/orchestration/")) {
            headers.set("x-t3-orchestration-protocol", "2");
          }
          let body: string | undefined;
          if (options.body !== undefined) {
            headers.set("content-type", "application/json");
            body = JSON.stringify(options.body);
          }
          const response = await handler(
            new Request(`http://environment.test${path}`, {
              method: options.method ?? "GET",
              headers,
              ...(body === undefined ? {} : { body }),
            }),
          );
          const text = await response.text();
          let json: unknown = null;
          try {
            json = text.length > 0 ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          return { status: response.status, text, json };
        }),
      ({ dispose }) => Effect.promise(() => dispose()),
    );
  });

describe("CRM service, HTTP, PII encryption, DSR, and external principals", () => {
  it.live(
    "enforces capability matrix: manager/admin/owner can write and invite, developer/viewer can read only",
    () =>
      Effect.gen(function* () {
        const tokens = yield* seedProjectsAndPrincipals;

        yield* withHttpHandler((request) =>
          Effect.promise(async () => {
            // Manager can create a client, contact, note, and invite.
            const created = await request(`/api/projects/${PROJECT_A}/crm/clients`, {
              method: "POST",
              token: tokens.managerToken,
              body: {
                name: "Acme Corp",
                company: "Acme Holdings",
                email: "alice@acme.example",
                phone: "+1 555-014-8899",
              },
            });
            expect(created.status).toBe(200);
            const client = created.json as CrmClient;
            expect(client.name).toBe("Acme Corp");
            expect(client.emailMasked).toBe("a***@acme.example");
            expect(client.phoneMasked).toBe("***8899");

            const managerInvite = await request(
              `/api/projects/${PROJECT_A}/crm/clients/${client.id}/invite`,
              { method: "POST", token: tokens.managerToken },
            );
            expect(managerInvite.status).toBe(200);
            expect((managerInvite.json as CrmClientInviteResult).invitation.kind).toBe("client");

            // Admin and owner can also mutate and invite.
            const adminPatch = await request(
              `/api/projects/${PROJECT_A}/crm/clients/${client.id}`,
              {
                method: "PATCH",
                token: tokens.adminToken,
                body: { status: "lead" },
              },
            );
            expect(adminPatch.status).toBe(200);

            const ownerContact = await request(
              `/api/projects/${PROJECT_A}/crm/clients/${client.id}/contacts`,
              {
                method: "POST",
                token: tokens.ownerToken,
                body: { name: "Bob Owner", email: "bob@acme.example" },
              },
            );
            expect(ownerContact.status).toBe(200);

            // Developer can read, CANNOT mutate or invite.
            const devList = await request(`/api/projects/${PROJECT_A}/crm/clients`, {
              token: tokens.developerToken,
            });
            expect(devList.status).toBe(200);
            expect((devList.json as ReadonlyArray<CrmClient>).length).toBe(1);

            const devCreate = await request(`/api/projects/${PROJECT_A}/crm/clients`, {
              method: "POST",
              token: tokens.developerToken,
              body: { name: "Forbidden Client" },
            });
            expect(devCreate.status).toBe(403);

            const devUpdate = await request(`/api/projects/${PROJECT_A}/crm/clients/${client.id}`, {
              method: "PATCH",
              token: tokens.developerToken,
              body: { name: "Hacked" },
            });
            expect(devUpdate.status).toBe(403);

            const devInvite = await request(
              `/api/projects/${PROJECT_A}/crm/clients/${client.id}/invite`,
              { method: "POST", token: tokens.developerToken },
            );
            expect(devInvite.status).toBe(403);

            const devPurge = await request(
              `/api/projects/${PROJECT_A}/crm/clients/${client.id}?purge=true`,
              { method: "DELETE", token: tokens.developerToken },
            );
            expect(devPurge.status).toBe(403);

            // Viewer can read, CANNOT write or invite.
            const viewerList = await request(`/api/projects/${PROJECT_A}/crm/clients`, {
              token: tokens.viewerToken,
            });
            expect(viewerList.status).toBe(200);
            const viewerCreate = await request(`/api/projects/${PROJECT_A}/crm/clients`, {
              method: "POST",
              token: tokens.viewerToken,
              body: { name: "Viewer Client" },
            });
            expect(viewerCreate.status).toBe(403);

            // Outsider with no project membership is rejected on read.
            const outsiderList = await request(`/api/projects/${PROJECT_A}/crm/clients`, {
              token: tokens.outsiderToken,
            });
            expect(outsiderList.status).toBe(403);
          }),
        );
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.live(
    "returns 404 on cross-project client/contact/note access and blocks cross-project thread links",
    () =>
      Effect.gen(function* () {
        const tokens = yield* seedProjectsAndPrincipals;

        yield* withHttpHandler((request) =>
          Effect.promise(async () => {
            const clientRes = await request(`/api/projects/${PROJECT_A}/crm/clients`, {
              method: "POST",
              token: tokens.managerToken,
              body: { name: "Alpha Client" },
            });
            const clientA = clientRes.json as CrmClient;

            const contactRes = await request(
              `/api/projects/${PROJECT_A}/crm/clients/${clientA.id}/contacts`,
              {
                method: "POST",
                token: tokens.managerToken,
                body: { name: "Alpha Contact" },
              },
            );
            const contactA = contactRes.json as CrmContact;

            const noteRes = await request(
              `/api/projects/${PROJECT_A}/crm/clients/${clientA.id}/notes`,
              {
                method: "POST",
                token: tokens.managerToken,
                body: { body: "Alpha Note" },
              },
            );
            const noteA = noteRes.json as CrmNote;

            // Cross-project reads & mutations return 404 even when manager belongs to both projects.
            expect(
              (
                await request(`/api/projects/${PROJECT_B}/crm/clients/${clientA.id}`, {
                  token: tokens.managerToken,
                })
              ).status,
            ).toBe(404);
            expect(
              (
                await request(`/api/projects/${PROJECT_B}/crm/clients/${clientA.id}`, {
                  method: "PATCH",
                  token: tokens.managerToken,
                  body: { name: "Cross Project Edit" },
                })
              ).status,
            ).toBe(404);
            expect(
              (
                await request(
                  `/api/projects/${PROJECT_B}/crm/clients/${clientA.id}/contacts/${contactA.id}`,
                  {
                    method: "DELETE",
                    token: tokens.managerToken,
                  },
                )
              ).status,
            ).toBe(404);
            expect(
              (
                await request(
                  `/api/projects/${PROJECT_B}/crm/clients/${clientA.id}/notes/${noteA.id}`,
                  {
                    method: "DELETE",
                    token: tokens.managerToken,
                  },
                )
              ).status,
            ).toBe(404);

            // Thread from Project B cannot be linked to a client in Project A.
            const crossThreadLink = await request(
              `/api/projects/${PROJECT_A}/crm/clients/${clientA.id}/threads`,
              {
                method: "POST",
                token: tokens.managerToken,
                body: { threadId: THREAD_B },
              },
            );
            expect(crossThreadLink.status).toBe(404);

            // Same-project thread links cleanly.
            const sameProjectLink = await request(
              `/api/projects/${PROJECT_A}/crm/clients/${clientA.id}/threads`,
              {
                method: "POST",
                token: tokens.managerToken,
                body: { threadId: THREAD_A_LINKED },
              },
            );
            expect(sameProjectLink.status).toBe(200);
            expect((sameProjectLink.json as CrmClientThread).threadId).toBe(THREAD_A_LINKED);
          }),
        );
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.live(
    "encrypts PII at rest with fingerprints, masks responses, exports JSONL and purges PII while keeping the row",
    () =>
      Effect.gen(function* () {
        const tokens = yield* seedProjectsAndPrincipals;
        const sql = yield* SqlClient.SqlClient;
        const auditRepo = yield* AuditEvents.AuditEventRepository;

        const rawEmail = "secret.client@privacy.example";
        const rawPhone = "+44 20 7946 0958";
        const contactEmail = "jane.contact@privacy.example";
        const contactPhone = "+44 20 7946 1234";

        const clientId = yield* withHttpHandler((request) =>
          Effect.promise(async () => {
            const created = await request(`/api/projects/${PROJECT_A}/crm/clients`, {
              method: "POST",
              token: tokens.managerToken,
              body: {
                name: "Privacy Client",
                company: "Privacy LLC",
                email: rawEmail,
                phone: rawPhone,
              },
            });
            expect(created.status).toBe(200);
            const client = created.json as CrmClient;
            expect(client.emailMasked).toBe("s***@privacy.example");
            expect(client.phoneMasked).toBe("***0958");
            expect(client.emailFingerprint).toBe(
              ProjectSecrets.fingerprintSecretValue(rawEmail.toLowerCase()),
            );
            expect(client.phoneFingerprint).toBe(ProjectSecrets.fingerprintSecretValue(rawPhone));
            expect(created.text).not.toContain(rawEmail);
            expect(created.text).not.toContain(rawPhone);

            const contactRes = await request(
              `/api/projects/${PROJECT_A}/crm/clients/${client.id}/contacts`,
              {
                method: "POST",
                token: tokens.managerToken,
                body: {
                  name: "Jane Contact",
                  roleTitle: "CTO",
                  email: contactEmail,
                  phone: contactPhone,
                },
              },
            );
            expect(contactRes.status).toBe(200);
            expect(contactRes.text).not.toContain(contactEmail);
            expect(contactRes.text).not.toContain(contactPhone);

            await request(`/api/projects/${PROJECT_A}/crm/clients/${client.id}/notes`, {
              method: "POST",
              token: tokens.managerToken,
              body: { body: "Confidential onboarding notes" },
            });

            // Export JSONL: valid newline-delimited JSON with masked PII only.
            const exported = await request(`/api/projects/${PROJECT_A}/crm/export`, {
              token: tokens.managerToken,
            });
            expect(exported.status).toBe(200);
            expect(exported.text).not.toContain(rawEmail);
            expect(exported.text).not.toContain(rawPhone);
            expect(exported.text).not.toContain(contactEmail);
            const lines = exported.text
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line) as { type: string; emailMasked?: string });
            expect(lines.map((entry) => entry.type)).toEqual(["client", "contact", "note"]);
            expect(lines[0]?.emailMasked).toBe("s***@privacy.example");

            return client.id;
          }),
        );

        // Verify raw SQLite storage holds encrypted BLOB ciphertext and no plaintext PII.
        const rawClientRows = yield* sql<{
          readonly id: string;
          readonly email_ciphertext: Uint8Array | null;
          readonly email_fingerprint: string | null;
          readonly phone_ciphertext: Uint8Array | null;
          readonly phone_fingerprint: string | null;
          readonly redacted_at: number | null;
        }>`
          SELECT id, email_ciphertext, email_fingerprint, phone_ciphertext, phone_fingerprint, redacted_at
          FROM crm_clients
          WHERE id = ${clientId}
        `;
        expect(rawClientRows).toHaveLength(1);
        const beforePurge = rawClientRows[0]!;
        expect(beforePurge.email_ciphertext).toBeInstanceOf(Uint8Array);
        expect(beforePurge.phone_ciphertext).toBeInstanceOf(Uint8Array);
        expect(Buffer.from(beforePurge.email_ciphertext!).toString("utf8")).not.toContain(rawEmail);
        expect(Buffer.from(beforePurge.phone_ciphertext!).toString("utf8")).not.toContain(rawPhone);
        expect(beforePurge.redacted_at).toBeNull();

        // Execute DSR purge: DELETE ?purge=true clears ciphertext/fingerprints and keeps the row.
        yield* withHttpHandler((request) =>
          Effect.promise(async () => {
            const purged = await request(
              `/api/projects/${PROJECT_A}/crm/clients/${clientId}?purge=true`,
              { method: "DELETE", token: tokens.managerToken },
            );
            expect(purged.status).toBe(200);
            expect(purged.json).toMatchObject({ deleted: false, purged: true });

            // Editing a purged client is rejected.
            const editPurged = await request(`/api/projects/${PROJECT_A}/crm/clients/${clientId}`, {
              method: "PATCH",
              token: tokens.managerToken,
              body: { name: "Resurrected" },
            });
            expect(editPurged.status).toBe(400);
          }),
        );

        // Row is kept with redacted_at set and all PII ciphertexts & fingerprints cleared.
        const afterClientRows = yield* sql<{
          readonly id: string;
          readonly name: string;
          readonly company: string | null;
          readonly email_ciphertext: Uint8Array | null;
          readonly email_fingerprint: string | null;
          readonly phone_ciphertext: Uint8Array | null;
          readonly phone_fingerprint: string | null;
          readonly redacted_at: number | null;
        }>`
          SELECT id, name, company, email_ciphertext, email_fingerprint, phone_ciphertext, phone_fingerprint, redacted_at
          FROM crm_clients
          WHERE id = ${clientId}
        `;
        expect(afterClientRows).toHaveLength(1);
        const afterPurge = afterClientRows[0]!;
        expect(afterPurge.name).toBe(CRM_REDACTED_PLACEHOLDER);
        expect(afterPurge.company).toBeNull();
        expect(afterPurge.email_ciphertext).toBeNull();
        expect(afterPurge.email_fingerprint).toBeNull();
        expect(afterPurge.phone_ciphertext).toBeNull();
        expect(afterPurge.phone_fingerprint).toBeNull();
        expect(afterPurge.redacted_at).not.toBeNull();

        const afterContactRows = yield* sql<{
          readonly email_ciphertext: Uint8Array | null;
          readonly phone_ciphertext: Uint8Array | null;
          readonly redacted_at: number | null;
        }>`
          SELECT email_ciphertext, phone_ciphertext, redacted_at
          FROM crm_contacts
          WHERE client_id = ${clientId}
        `;
        expect(afterContactRows).toHaveLength(1);
        expect(afterContactRows[0]!.email_ciphertext).toBeNull();
        expect(afterContactRows[0]!.phone_ciphertext).toBeNull();
        expect(afterContactRows[0]!.redacted_at).not.toBeNull();

        const afterNoteRows = yield* sql<{
          readonly body: string;
          readonly redacted_at: number | null;
        }>`
          SELECT body, redacted_at FROM crm_notes WHERE client_id = ${clientId}
        `;
        expect(afterNoteRows).toHaveLength(1);
        expect(afterNoteRows[0]!.body).toBe("");
        expect(afterNoteRows[0]!.redacted_at).not.toBeNull();

        // Audit events recorded crm.exported and crm.purged with masked PII only.
        const events = yield* auditRepo.list({ projectId: PROJECT_A, limit: 20 });
        const exportedEvent = events.find((event) => event.action === "crm.exported");
        const purgedEvent = events.find((event) => event.action === "crm.purged");
        expect(exportedEvent).toBeDefined();
        expect(purgedEvent).toBeDefined();
        const serializedEvents = JSON.stringify([exportedEvent, purgedEvent]);
        expect(serializedEvents).toContain("s***@privacy.example");
        expect(serializedEvents).toContain("***0958");
        expect(serializedEvents).not.toContain(rawEmail);
        expect(serializedEvents).not.toContain(rawPhone);
        expect(serializedEvents).not.toContain(contactEmail);
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.live(
    "external principal sees only its own CRM client record and linked threads across HTTP and shell filter",
    () =>
      Effect.gen(function* () {
        const tokens = yield* seedProjectsAndPrincipals;
        const invitations = yield* InvitationService.InvitationService;
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const access = yield* ProjectAccess.ProjectAccess;
        const resolver = yield* ResourceResolver.ResourceResolver;

        // Create two clients in Project A, link THREAD_A_LINKED to client 1, and invite client 1.
        const setup = yield* withHttpHandler((request) =>
          Effect.promise(async () => {
            const c1 = (
              await request(`/api/projects/${PROJECT_A}/crm/clients`, {
                method: "POST",
                token: tokens.managerToken,
                body: { name: "Client One", email: "one@client.example" },
              })
            ).json as CrmClient;
            const c2 = (
              await request(`/api/projects/${PROJECT_A}/crm/clients`, {
                method: "POST",
                token: tokens.managerToken,
                body: { name: "Client Two", email: "two@client.example" },
              })
            ).json as CrmClient;

            await request(`/api/projects/${PROJECT_A}/crm/clients/${c1.id}/threads`, {
              method: "POST",
              token: tokens.managerToken,
              body: { threadId: THREAD_A_LINKED },
            });

            const invited = (
              await request(`/api/projects/${PROJECT_A}/crm/clients/${c1.id}/invite`, {
                method: "POST",
                token: tokens.managerToken,
              })
            ).json as CrmClientInviteResult;

            return { client1: c1, client2: c2, inviteCode: invited.code };
          }),
        );

        // External client accepts the invitation -> principal kind is 'external' and bound to client1.
        const consumed = yield* invitations.consume({
          code: setup.inviteCode,
          displayName: "Client One User",
        });
        expect(consumed.principal.kind).toBe("external");

        const resolvedPrincipal = yield* resolver.resolveCrmClientPrincipal(setup.client1.id);
        expect(resolvedPrincipal).toBe(consumed.principal.id);
        expect(yield* resolver.resolveCrmClientPrincipal(setup.client2.id)).toBeUndefined();

        const externalSession = yield* auth.issuePrincipalSession({
          principalId: consumed.principal.id,
          binding: { _tag: "principal" },
          scopes: [...ceilingScopes("client")],
          method: "bearer-access-token",
          client: { deviceType: "desktop" },
        });

        // HTTP CRM + Orchestration enforcement for the external principal.
        yield* withHttpHandler((request) =>
          Effect.promise(async () => {
            // Sees only its own client in list.
            const listRes = await request(`/api/projects/${PROJECT_A}/crm/clients`, {
              token: externalSession.token,
            });
            expect(listRes.status).toBe(200);
            const listed = listRes.json as ReadonlyArray<CrmClient>;
            expect(listed.map((entry) => entry.id)).toEqual([setup.client1.id]);

            // Can read its own client detail.
            const ownDetail = await request(
              `/api/projects/${PROJECT_A}/crm/clients/${setup.client1.id}`,
              { token: externalSession.token },
            );
            expect(ownDetail.status).toBe(200);
            expect((ownDetail.json as CrmClientDetail).client.id).toBe(setup.client1.id);

            // Cannot read another client in the same project -> 404.
            const foreignDetail = await request(
              `/api/projects/${PROJECT_A}/crm/clients/${setup.client2.id}`,
              { token: externalSession.token },
            );
            expect(foreignDetail.status).toBe(404);

            // Cannot mutate CRM -> 403.
            const createAttempt = await request(`/api/projects/${PROJECT_A}/crm/clients`, {
              method: "POST",
              token: externalSession.token,
              body: { name: "Sneaky" },
            });
            expect(createAttempt.status).toBe(403);

            // HTTP orchestration shell snapshot shows ONLY linked threads.
            const shellRes = await request("/api/orchestration/shell", {
              token: externalSession.token,
            });
            expect(shellRes.status).toBe(200);
            const shellBody = shellRes.json as { threads: ReadonlyArray<{ id: string }> };
            expect(shellBody.threads.map((thread) => thread.id)).toEqual([THREAD_A_LINKED]);

            // Linked thread transcript is readable; unlinked thread in the SAME project is 404.
            const linkedTranscript = await request(
              `/api/orchestration/threads/${THREAD_A_LINKED}/transcript`,
              { token: externalSession.token },
            );
            expect(linkedTranscript.status).toBe(200);
            const unlinkedTranscript = await request(
              `/api/orchestration/threads/${THREAD_A_UNLINKED}/transcript`,
              { token: externalSession.token },
            );
            expect(unlinkedTranscript.status).toBe(404);
          }),
        );

        // Shell stream filter and RPC access gate enforcement for the external principal.
        const externalActor = yield* access.resolve({
          sessionId: AuthSessionId.make("ext-ws"),
          subject: `principal:${consumed.principal.id}`,
          scopes: [...ceilingScopes("client")],
          principalId: consumed.principal.id,
          binding: { _tag: "principal" },
        });
        expect(externalActor.principalKind).toBe("external");

        const allowedProjects = access.accessibleProjectIds(externalActor);
        const allowedThreads = yield* resolver.resolveExternalPrincipalThreadIds(
          consumed.principal.id,
        );
        expect(Array.from(allowedThreads)).toEqual([THREAD_A_LINKED]);

        const rawSnapshot: OrchestrationV2ShellSnapshot = {
          schemaVersion: 1,
          snapshotSequence: 5,
          projects: [makeProjectShell(PROJECT_A), makeProjectShell(PROJECT_B)],
          threads: [
            makeThreadShell(THREAD_A_LINKED, PROJECT_A),
            makeThreadShell(THREAD_A_UNLINKED, PROJECT_A),
            makeThreadShell(THREAD_B, PROJECT_B),
          ],
          archivedThreads: [],
        };
        const filtered = filterShellSnapshot(rawSnapshot, allowedProjects, allowedThreads);
        expect(filtered.projects.map((p) => p.id)).toEqual([PROJECT_A]);
        expect(filtered.threads.map((t) => t.id)).toEqual([THREAD_A_LINKED]);

        expect(
          filterShellStreamItem(
            {
              kind: "thread.updated",
              sequence: 6,
              location: "active",
              thread: makeThreadShell(THREAD_A_UNLINKED, PROJECT_A),
            },
            allowedProjects,
            allowedThreads,
            allowedThreads,
          ),
        ).toBeNull();
        expect(
          filterShellStreamItem(
            {
              kind: "thread.updated",
              sequence: 7,
              location: "active",
              thread: makeThreadShell(THREAD_A_LINKED, PROJECT_A),
            },
            allowedProjects,
            allowedThreads,
            allowedThreads,
          ),
        ).not.toBeNull();

        const gate = RpcAuthorization.makeAccessGate({
          actor: externalActor,
          access,
          resolver,
        });
        // Linked thread passes RPC gate; unlinked thread in same project is rejected.
        yield* gate.check(ORCHESTRATION_V2_WS_METHODS.getThreadProjection, {
          threadId: THREAD_A_LINKED,
        });
        const unlinkedExit = yield* Effect.exit(
          gate.check(ORCHESTRATION_V2_WS_METHODS.getThreadProjection, {
            threadId: THREAD_A_UNLINKED,
          }),
        );
        expect(unlinkedExit._tag).toBe("Failure");

        // Also verify issuing invitation directly with kind: 'external' maps to client/external principal.
        const directExternalInvite = yield* invitations.issue({
          kind: "external",
          role: "viewer",
          projectId: PROJECT_A,
          crmClientId: setup.client2.id,
          createdBy: MANAGER_ID,
        });
        expect(directExternalInvite.invitation.kind).toBe("client");
        expect(directExternalInvite.invitation.crmClientId).toBe(setup.client2.id);
        const directConsumed = yield* invitations.consume({
          code: directExternalInvite.code,
          displayName: "Client Two User",
        });
        expect(directConsumed.principal.kind).toBe("external");
        expect(yield* resolver.resolveCrmClientPrincipal(setup.client2.id)).toBe(
          directConsumed.principal.id,
        );
      }).pipe(Effect.provide(makeTestLayer())),
  );
});
