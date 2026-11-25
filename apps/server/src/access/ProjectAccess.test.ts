import { describe, expect, it } from "@effect/vitest";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthEnvironmentMaintainScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthSessionId,
  AuthSettingsWriteScope,
  AuthStandardClientScopes,
  AuthTerminalOperateScope,
  PrincipalId,
  ProjectCapability,
  ProjectId,
  type Principal,
  type ProjectMembership,
  type ProjectRole,
  ceilingScopes,
  roleHasCapability,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Memberships from "../persistence/Memberships.ts";
import * as Principals from "../persistence/Principals.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectAccess from "./ProjectAccess.ts";

const NOW = "2026-11-25T00:00:00.000Z";
const SESSION_ID = AuthSessionId.make("session-1");
const OWNER_ID = PrincipalId.make("owner");
const DEV_ID = PrincipalId.make("member-dev");
const VIEWER_ID = PrincipalId.make("member-viewer");
const SUSPENDED_ID = PrincipalId.make("member-suspended");
const REMOVED_ID = PrincipalId.make("member-removed");
const SERVICE_ID = PrincipalId.make("service-ci");
const PROJECT_A = ProjectId.make("project-a");
const PROJECT_B = ProjectId.make("project-b");
const PROJECT_C = ProjectId.make("project-c");

function makePrincipal(overrides: Partial<Principal> & Pick<Principal, "id" | "kind">): Principal {
  return {
    displayName: overrides.id,
    email: null,
    status: "active",
    ceiling: [],
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

function makeAccessLayer(options: {
  readonly principals?: ReadonlyArray<Principal>;
  readonly memberships?: ReadonlyArray<ProjectMembership>;
  readonly ownedProjects?: ReadonlyArray<{
    readonly projectId: ProjectId;
    readonly ownerId: PrincipalId;
  }>;
}) {
  const principalMap = new Map((options.principals ?? []).map((p) => [p.id, p]));
  const membershipList = options.memberships ?? [];
  const ownedList = options.ownedProjects ?? [];

  const principalRepo = Layer.succeed(Principals.PrincipalRepository, {
    get: (id) => Effect.succeed(Option.fromNullishOr(principalMap.get(id))),
    getByEmail: () => Effect.die("unused"),
    list: Effect.succeed([...principalMap.values()]),
    create: () => Effect.die("unused"),
    update: () => Effect.die("unused"),
    bumpAccessRevision: () => Effect.die("unused"),
    getCredential: () => Effect.die("unused"),
    setCredential: () => Effect.die("unused"),
    deleteCredential: () => Effect.die("unused"),
  });

  const membershipRepo = Layer.succeed(Memberships.MembershipRepository, {
    get: (projectId, principalId) =>
      Effect.succeed(
        Option.fromNullishOr(
          membershipList.find((m) => m.projectId === projectId && m.principalId === principalId),
        ),
      ),
    listForProject: (projectId) =>
      Effect.succeed(membershipList.filter((m) => m.projectId === projectId)),
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
    listShells: () => Effect.die("unused"),
    setOwnership: () => Effect.die("unused"),
    listOwnedByPrincipal: (principalId) =>
      Effect.succeed(
        ownedList.filter((row) => row.ownerId === principalId).map((row) => row.projectId),
      ),
  });

  return ProjectAccess.layer.pipe(
    Layer.provide(Layer.mergeAll(principalRepo, membershipRepo, projectStore)),
  );
}

const baseLayer = makeAccessLayer({
  principals: [
    makePrincipal({ id: OWNER_ID, kind: "owner", ceiling: [] }),
    makePrincipal({
      id: DEV_ID,
      kind: "member",
      ceiling: [...ceilingScopes("staff")],
    }),
    makePrincipal({
      id: VIEWER_ID,
      kind: "member",
      ceiling: [...ceilingScopes("client")],
    }),
    makePrincipal({
      id: SUSPENDED_ID,
      kind: "member",
      status: "suspended",
      ceiling: [...ceilingScopes("staff")],
    }),
    makePrincipal({
      id: REMOVED_ID,
      kind: "member",
      status: "removed",
      removedAt: NOW,
      ceiling: [...ceilingScopes("staff")],
    }),
    makePrincipal({
      id: SERVICE_ID,
      kind: "service",
      ceiling: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
    }),
  ],
  memberships: [
    makeMembership({ projectId: PROJECT_A, principalId: DEV_ID, role: "developer" }),
    makeMembership({
      projectId: PROJECT_B,
      principalId: DEV_ID,
      role: "admin",
      state: "suspended",
    }),
    makeMembership({
      projectId: PROJECT_C,
      principalId: DEV_ID,
      role: "developer",
      state: "invited",
    }),
    makeMembership({ projectId: PROJECT_A, principalId: VIEWER_ID, role: "viewer" }),
  ],
});

describe("ProjectAccess", () => {
  it.layer(baseLayer)("with seeded principals and memberships", (it) => {
    it.effect("lets an owner principal pass every capability and keeps all scopes", () =>
      Effect.gen(function* () {
        const access = yield* ProjectAccess.ProjectAccess;
        const actor = yield* access.resolve({
          sessionId: SESSION_ID,
          subject: "owner",
          scopes: [...AuthStandardClientScopes, AuthEnvironmentMaintainScope],
          principalId: OWNER_ID,
          binding: { _tag: "environment" },
        });

        expect(actor.isOwner).toBe(true);
        expect(actor.ceiling).toBeUndefined();
        expect(access.accessibleProjectIds(actor)).toBeUndefined();
        expect(access.effectiveScopes(actor)).toEqual([
          ...AuthStandardClientScopes,
          AuthEnvironmentMaintainScope,
        ]);

        for (const capability of ProjectCapability.literals) {
          expect(access.can(actor, PROJECT_A, capability)).toBe(true);
          expect(access.can(actor, PROJECT_B, capability)).toBe(true);
          yield* access.assert(actor, PROJECT_A, capability);
        }
      }),
    );

    it.effect("treats legacy sessions without principal or binding as owner-equivalent", () =>
      Effect.gen(function* () {
        const access = yield* ProjectAccess.ProjectAccess;
        const scopes = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope] as const;
        const actor = yield* access.resolve({
          sessionId: SESSION_ID,
          subject: "legacy",
          scopes,
        });

        expect(actor.isOwner).toBe(true);
        expect(actor.roles.size).toBe(0);
        expect(access.accessibleProjectIds(actor)).toBeUndefined();
        expect(access.effectiveScopes(actor)).toEqual(scopes);
        expect(access.can(actor, PROJECT_A, "project:delete")).toBe(true);
        yield* access.assert(actor, PROJECT_B, "project:settings");
      }),
    );

    it.effect(
      "grants principal-bound developer thread and file capabilities while denying admin/owner ones",
      () =>
        Effect.gen(function* () {
          const access = yield* ProjectAccess.ProjectAccess;
          const actor = yield* access.resolve({
            sessionId: SESSION_ID,
            subject: "dev",
            scopes: [...AuthStandardClientScopes],
            principalId: DEV_ID,
            binding: { _tag: "principal" },
          });

          expect(actor.isOwner).toBe(false);
          expect(access.accessibleProjectIds(actor)).toEqual(new Set([PROJECT_A]));

          for (const allowed of [
            "project:read",
            "project:thread.operate",
            "project:thread.manage",
            "project:file.write",
            "project:source.write",
            "project:terminal.read",
            "project:terminal.operate",
            "project:preview.operate",
            "project:create",
          ] as const) {
            expect(access.can(actor, PROJECT_A, allowed)).toBe(true);
            yield* access.assert(actor, PROJECT_A, allowed);
          }

          for (const denied of [
            "project:settings",
            "project:members",
            "project:secrets",
            "project:webhooks",
            "project:delete",
          ] as const) {
            expect(access.can(actor, PROJECT_A, denied)).toBe(false);
            const error = yield* access.assert(actor, PROJECT_A, denied).pipe(Effect.flip);
            expect(error._tag).toBe("project_forbidden");
            expect(error.projectId).toBe(PROJECT_A);
            expect(error.requiredPermission).toBe(denied);
          }

          // Suspended and invited memberships on other projects grant nothing.
          expect(access.can(actor, PROJECT_B, "project:read")).toBe(false);
          expect(access.can(actor, PROJECT_C, "project:read")).toBe(false);
        }),
    );

    it.effect("includes project:create for developer and excludes it for viewer", () =>
      Effect.gen(function* () {
        const access = yield* ProjectAccess.ProjectAccess;
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

        expect(access.can(dev, PROJECT_A, "project:create")).toBe(true);
        expect(access.can(viewer, PROJECT_A, "project:create")).toBe(false);
        const error = yield* access.assert(viewer, PROJECT_A, "project:create").pipe(Effect.flip);
        expect(error.requiredPermission).toBe("project:create");
      }),
    );

    it.effect.each([
      { principalId: PrincipalId.make("missing"), reason: "principal_not_found" as const },
      { principalId: SUSPENDED_ID, reason: "principal_suspended" as const },
      { principalId: REMOVED_ID, reason: "principal_removed" as const },
    ])("fails resolve with $reason for $principalId", ({ principalId, reason }) =>
      Effect.gen(function* () {
        const access = yield* ProjectAccess.ProjectAccess;
        const error = yield* access
          .resolve({
            sessionId: SESSION_ID,
            subject: principalId,
            scopes: [AuthOrchestrationReadScope],
            principalId,
            binding: { _tag: "principal" },
          })
          .pipe(Effect.flip);

        expect(error._tag).toBe("AccessResolveError");
        expect(error.reason).toBe(reason);
        expect(error.principalId).toBe(principalId);
      }),
    );

    it.effect("restricts a projects-bound session to its bound projects and bound roles", () =>
      Effect.gen(function* () {
        const access = yield* ProjectAccess.ProjectAccess;
        const actor = yield* access.resolve({
          sessionId: SESSION_ID,
          subject: "dev-pat",
          scopes: [...AuthStandardClientScopes],
          principalId: DEV_ID,
          binding: {
            _tag: "projects",
            projects: [{ projectId: PROJECT_B, role: "operator" }],
          },
        });

        expect(access.accessibleProjectIds(actor)).toEqual(new Set([PROJECT_B]));
        expect(access.can(actor, PROJECT_B, "project:thread.operate")).toBe(true);
        expect(access.can(actor, PROJECT_B, "project:file.write")).toBe(false);
        // Does not widen to the principal's live membership on PROJECT_A.
        expect(access.can(actor, PROJECT_A, "project:read")).toBe(false);
      }),
    );

    it.effect("narrows effectiveScopes by the principal ceiling", () =>
      Effect.gen(function* () {
        const access = yield* ProjectAccess.ProjectAccess;
        const viewer = yield* access.resolve({
          sessionId: SESSION_ID,
          subject: "viewer",
          scopes: [
            AuthOrchestrationReadScope,
            AuthOrchestrationOperateScope,
            AuthFilesystemReadScope,
            AuthFilesystemWriteScope,
            AuthSettingsWriteScope,
            AuthAccessReadScope,
            AuthAccessWriteScope,
          ],
          principalId: VIEWER_ID,
          binding: { _tag: "principal" },
        });

        expect(access.effectiveScopes(viewer)).toEqual([
          AuthOrchestrationReadScope,
          AuthFilesystemReadScope,
          AuthAccessReadScope,
        ]);

        const service = yield* access.resolve({
          sessionId: SESSION_ID,
          subject: "ci",
          scopes: [
            AuthOrchestrationReadScope,
            AuthOrchestrationOperateScope,
            AuthTerminalOperateScope,
            AuthPreviewOperateScope,
          ],
          principalId: SERVICE_ID,
          binding: { _tag: "environment" },
        });

        expect(service.isOwner).toBe(false);
        expect(access.accessibleProjectIds(service)).toBeUndefined();
        expect(access.can(service, PROJECT_A, "project:read")).toBe(true);
        expect(access.effectiveScopes(service)).toEqual([
          AuthOrchestrationReadScope,
          AuthOrchestrationOperateScope,
        ]);
      }),
    );
  });

  describe("role-by-capability matrix", () => {
    const projectRoles: ReadonlyArray<ProjectRole> = [
      "viewer",
      "operator",
      "developer",
      "manager",
      "admin",
    ];

    it.effect.each(projectRoles)(
      "matches roleHasCapability for every capability on role %s",
      (role) =>
        Effect.gen(function* () {
          const principalId = PrincipalId.make(`principal-${role}`);
          const principal = makePrincipal({
            id: principalId,
            kind: "member",
            ceiling: [...ceilingScopes("staff")],
          });
          const layer = makeAccessLayer({
            principals: [principal],
            memberships: [makeMembership({ projectId: PROJECT_A, principalId, role })],
          });

          yield* Effect.gen(function* () {
            const access = yield* ProjectAccess.ProjectAccess;
            const actor = yield* access.resolve({
              sessionId: SESSION_ID,
              subject: principalId,
              scopes: [...AuthStandardClientScopes],
              principalId,
              binding: { _tag: "principal" },
            });

            for (const capability of ProjectCapability.literals) {
              expect(access.can(actor, PROJECT_A, capability)).toBe(
                roleHasCapability(role, capability),
              );
            }
          }).pipe(Effect.provide(layer));
        }),
    );
  });

  describe("private project ownership and visibility", () => {
    const CREATOR_ID = PrincipalId.make("member-creator");
    const STRANGER_ID = PrincipalId.make("member-stranger");
    const SHARED_PROJECT = ProjectId.make("project-kotcrm");
    const PRIVATE_PROJECT = ProjectId.make("project-private");
    const PRIVATE_OWNED_ONLY = ProjectId.make("project-private-owned-only");

    const privateLayer = makeAccessLayer({
      principals: [
        makePrincipal({ id: OWNER_ID, kind: "owner", ceiling: [] }),
        makePrincipal({
          id: CREATOR_ID,
          kind: "member",
          ceiling: [...ceilingScopes("staff")],
        }),
        makePrincipal({
          id: STRANGER_ID,
          kind: "member",
          ceiling: [...ceilingScopes("staff")],
        }),
      ],
      memberships: [
        makeMembership({ projectId: SHARED_PROJECT, principalId: CREATOR_ID, role: "developer" }),
        makeMembership({ projectId: SHARED_PROJECT, principalId: STRANGER_ID, role: "developer" }),
        makeMembership({ projectId: PRIVATE_PROJECT, principalId: CREATOR_ID, role: "admin" }),
      ],
      ownedProjects: [
        { projectId: PRIVATE_PROJECT, ownerId: CREATOR_ID },
        { projectId: PRIVATE_OWNED_ONLY, ownerId: CREATOR_ID },
      ],
    });

    it.layer(privateLayer)("narrows visibility to owner, creator, and active members", (it) => {
      it.effect(
        "shows creator their private projects and shared memberships, never to strangers",
        () =>
          Effect.gen(function* () {
            const access = yield* ProjectAccess.ProjectAccess;

            const creator = yield* access.resolve({
              sessionId: SESSION_ID,
              subject: "creator",
              scopes: [...AuthStandardClientScopes],
              principalId: CREATOR_ID,
              binding: { _tag: "principal" },
            });
            const stranger = yield* access.resolve({
              sessionId: SESSION_ID,
              subject: "stranger",
              scopes: [...AuthStandardClientScopes],
              principalId: STRANGER_ID,
              binding: { _tag: "principal" },
            });
            const owner = yield* access.resolve({
              sessionId: SESSION_ID,
              subject: "owner",
              scopes: [...AuthStandardClientScopes],
              principalId: OWNER_ID,
              binding: { _tag: "environment" },
            });

            // Creator sees shared membership plus owned/private projects.
            expect(access.accessibleProjectIds(creator)).toEqual(
              new Set([SHARED_PROJECT, PRIVATE_PROJECT, PRIVATE_OWNED_ONLY]),
            );
            expect(access.can(creator, PRIVATE_PROJECT, "project:settings")).toBe(true);
            expect(access.can(creator, PRIVATE_PROJECT, "project:members")).toBe(true);
            // Project delete remains owner-only, even for the creator/admin of a private project.
            expect(access.can(creator, PRIVATE_PROJECT, "project:delete")).toBe(false);

            // Stranger sees only their shared membership, never the creator's private projects.
            expect(access.accessibleProjectIds(stranger)).toEqual(new Set([SHARED_PROJECT]));
            expect(access.can(stranger, SHARED_PROJECT, "project:read")).toBe(true);
            expect(access.can(stranger, PRIVATE_PROJECT, "project:read")).toBe(false);
            expect(access.can(stranger, PRIVATE_OWNED_ONLY, "project:read")).toBe(false);

            // Owner sees everything (undefined filter) and can delete any project.
            expect(access.accessibleProjectIds(owner)).toBeUndefined();
            expect(access.can(owner, PRIVATE_PROJECT, "project:read")).toBe(true);
            expect(access.can(owner, PRIVATE_PROJECT, "project:delete")).toBe(true);
          }),
      );

      it.effect("does not widen a projects-bound session to the principal's owned projects", () =>
        Effect.gen(function* () {
          const access = yield* ProjectAccess.ProjectAccess;
          const narrowCreator = yield* access.resolve({
            sessionId: SESSION_ID,
            subject: "creator-narrow",
            scopes: [...AuthStandardClientScopes],
            principalId: CREATOR_ID,
            binding: {
              _tag: "projects",
              projects: [{ projectId: SHARED_PROJECT, role: "developer" }],
            },
          });

          expect(access.accessibleProjectIds(narrowCreator)).toEqual(new Set([SHARED_PROJECT]));
          expect(access.can(narrowCreator, PRIVATE_PROJECT, "project:read")).toBe(false);
        }),
      );
    });
  });
});
