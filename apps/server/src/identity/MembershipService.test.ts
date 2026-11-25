import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import {
  ApiTokenId,
  AuthAdministrativeClientScopes,
  AuthSessionId,
  PrincipalId,
  ProjectId,
  ceilingScopes,
  roleScopes,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectAccess from "../access/ProjectAccess.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ApiTokens from "../persistence/ApiTokens.ts";
import * as AuditEvents from "../persistence/AuditEvents.ts";
import * as Invitations from "../persistence/Invitations.ts";
import * as MemberLimits from "../persistence/MemberLimits.ts";
import * as Memberships from "../persistence/Memberships.ts";
import * as Principals from "../persistence/Principals.ts";
import * as SessionPrincipals from "../persistence/SessionPrincipals.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as InvitationService from "./InvitationService.ts";
import * as MembershipService from "./MembershipService.ts";

const OWNER_ID = InvitationService.OWNER_PRINCIPAL_ID;
const PROJECT_A = ProjectId.make("project-a");
const PROJECT_B = ProjectId.make("project-b");
const SEED_TIME = "2026-11-25T00:00:00.000Z";

const makeTestLayer = () => {
  const config = ServerConfig.layerTest(process.cwd(), { prefix: "t3-membership-service-test-" });
  const secrets = ServerSecretStore.layer.pipe(Layer.provide(config));
  const sessions = SessionStore.layer.pipe(
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(secrets),
    Layer.provide(config),
  );
  const repos = Layer.mergeAll(
    Principals.layer,
    Memberships.layer,
    Invitations.layer,
    AuditEvents.layer,
    ApiTokens.layer,
    MemberLimits.layer,
    SessionPrincipals.layer,
  );
  const access = ProjectAccess.layer.pipe(Layer.provide(repos), Layer.provide(ProjectStore.layer));
  const membershipService = MembershipService.layer.pipe(
    Layer.provide(access),
    Layer.provide(repos),
    Layer.provide(sessions),
  );
  const invitationService = InvitationService.layer.pipe(
    Layer.provide(membershipService),
    Layer.provide(access),
    Layer.provide(repos),
    Layer.provide(secrets),
  );
  return Layer.mergeAll(
    membershipService,
    invitationService,
    access,
    repos,
    secrets,
    sessions,
  ).pipe(
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
};

const resolveActor = (principalId: PrincipalId, scopes = AuthAdministrativeClientScopes) =>
  Effect.gen(function* () {
    const access = yield* ProjectAccess.ProjectAccess;
    return yield* access.resolve({
      sessionId: AuthSessionId.make(`session-${principalId}`),
      subject: `principal:${principalId}`,
      scopes,
      principalId,
      binding: { _tag: "principal" },
    });
  });

const seedMember = (input: {
  readonly id: PrincipalId;
  readonly displayName: string;
  readonly ceiling?: "staff" | "restricted" | "client";
  readonly projectId?: ProjectId;
  readonly role?: "viewer" | "operator" | "developer" | "manager" | "admin";
  readonly state?: "active" | "suspended";
}) =>
  Effect.gen(function* () {
    const principals = yield* Principals.PrincipalRepository;
    const memberships = yield* Memberships.MembershipRepository;
    yield* principals.create({
      id: input.id,
      kind: "member",
      displayName: input.displayName,
      email: null,
      status: "active",
      ceiling: [...ceilingScopes(input.ceiling ?? "staff")],
      createdAt: SEED_TIME,
    });
    if (input.projectId !== undefined) {
      yield* memberships.upsert({
        projectId: input.projectId,
        principalId: input.id,
        role: input.role ?? "developer",
        state: input.state ?? "active",
        invitedBy: OWNER_ID,
        expiresAt: null,
        updatedAt: SEED_TIME,
      });
    }
  });

const expectFailureTag = <A, E>(effect: Effect.Effect<A, E>, tag: string, reason?: string) =>
  effect.pipe(
    Effect.exit,
    Effect.map((exit) => {
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        const first = exit.cause.reasons[0];
        assert.strictEqual(first?._tag, "Fail");
        if (first?._tag === "Fail") {
          const error = first.error as { readonly _tag?: string; readonly reason?: string };
          assert.strictEqual(error._tag, tag);
          if (reason !== undefined) {
            assert.strictEqual(error.reason, reason);
          }
        }
      }
    }),
  );

it.effect("lists all principals for owner and scopes listForActor to accessible projects", () =>
  Effect.gen(function* () {
    const service = yield* MembershipService.MembershipService;
    const adminA = PrincipalId.make("admin-a");
    const devA = PrincipalId.make("dev-a");
    const devB = PrincipalId.make("dev-b");

    yield* seedMember({ id: adminA, displayName: "Admin A", projectId: PROJECT_A, role: "admin" });
    yield* seedMember({
      id: devA,
      displayName: "Dev A",
      ceiling: "restricted",
      projectId: PROJECT_A,
      role: "operator",
    });
    yield* seedMember({ id: devB, displayName: "Dev B", projectId: PROJECT_B, role: "developer" });

    const ownerActor = yield* resolveActor(OWNER_ID);
    const ownerList = yield* service.listForActor(ownerActor);
    assert.deepStrictEqual(
      ownerList.map((row) => row.principal.id).sort(),
      [adminA, devA, devB, OWNER_ID].sort(),
    );
    const devAEntry = ownerList.find((row) => row.principal.id === devA)!;
    assert.deepStrictEqual(devAEntry.principal.ceiling, [...ceilingScopes("restricted")]);
    assert.strictEqual(devAEntry.principal.status, "active");

    const adminActor = yield* resolveActor(adminA);
    const adminList = yield* service.listForActor(adminActor);
    assert.deepStrictEqual(adminList.map((row) => row.principal.id).sort(), [adminA, devA].sort());
    expect(adminList.flatMap((row) => row.memberships.map((m) => m.projectId))).toEqual([
      PROJECT_A,
      PROJECT_A,
    ]);
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("enforces role rank clamp, ceiling clamp, owner bypass, and owner protection", () =>
  Effect.gen(function* () {
    const service = yield* MembershipService.MembershipService;
    const principals = yield* Principals.PrincipalRepository;
    const memberships = yield* Memberships.MembershipRepository;
    const audit = yield* AuditEvents.AuditEventRepository;

    const adminA = PrincipalId.make("admin-a");
    const restrictedAdminA = PrincipalId.make("restricted-admin-a");
    const devA = PrincipalId.make("dev-a");
    const restrictedMember = PrincipalId.make("restricted-member");
    const devB = PrincipalId.make("dev-b");

    yield* seedMember({ id: adminA, displayName: "Admin A", projectId: PROJECT_A, role: "admin" });
    yield* seedMember({
      id: restrictedAdminA,
      displayName: "Restricted Admin A",
      ceiling: "restricted",
      projectId: PROJECT_A,
      role: "admin",
    });
    yield* seedMember({ id: devA, displayName: "Dev A", projectId: PROJECT_A, role: "developer" });
    yield* seedMember({
      id: restrictedMember,
      displayName: "Restricted Member",
      ceiling: "restricted",
      projectId: PROJECT_A,
      role: "operator",
    });
    yield* seedMember({ id: devB, displayName: "Dev B", projectId: PROJECT_B, role: "developer" });

    // Give owner an explicit admin membership on Project A to verify non-owner cannot demote owner.
    yield* memberships.upsert({
      projectId: PROJECT_A,
      principalId: OWNER_ID,
      role: "admin",
      state: "active",
      invitedBy: OWNER_ID,
      expiresAt: null,
      updatedAt: SEED_TIME,
    });

    const ownerActor = yield* resolveActor(OWNER_ID);
    const adminActor = yield* resolveActor(adminA);
    const restrictedAdminActor = yield* resolveActor(restrictedAdminA);
    const devActor = yield* resolveActor(devA);

    // Developer cannot manage members.
    yield* expectFailureTag(
      service.setRole({
        actor: devActor,
        projectId: PROJECT_A,
        principalId: restrictedMember,
        role: "viewer",
      }),
      "MembershipForbiddenError",
      "not_authorized",
    );

    // Non-owner admin cannot assign role exceeding actor rank ("owner").
    yield* expectFailureTag(
      service.setRole({
        actor: adminActor,
        projectId: PROJECT_A,
        principalId: devA,
        role: "owner",
      }),
      "MembershipCeilingError",
      "role_exceeds_actor_rank",
    );

    // Non-owner admin cannot demote the owner principal.
    yield* expectFailureTag(
      service.setRole({
        actor: adminActor,
        projectId: PROJECT_A,
        principalId: OWNER_ID,
        role: "viewer",
      }),
      "MembershipForbiddenError",
      "owner_protected",
    );

    // Admin with restricted ceiling cannot assign developer (exceeds actor ceiling),
    // but can assign operator.
    yield* expectFailureTag(
      service.setRole({
        actor: restrictedAdminActor,
        projectId: PROJECT_A,
        principalId: devA,
        role: "developer",
      }),
      "MembershipCeilingError",
      "role_exceeds_actor_ceiling",
    );
    const demotedToOp = yield* service.setRole({
      actor: restrictedAdminActor,
      projectId: PROJECT_A,
      principalId: devA,
      role: "operator",
    });
    assert.strictEqual(demotedToOp.role, "operator");

    // Role scopes must fit the target principal's ceiling, even when called by owner.
    yield* expectFailureTag(
      service.setRole({
        actor: ownerActor,
        projectId: PROJECT_A,
        principalId: restrictedMember,
        role: "developer",
      }),
      "MembershipCeilingError",
      "role_exceeds_principal_ceiling",
    );

    // Owner cannot assign the "owner" role as a project membership.
    yield* expectFailureTag(
      service.setRole({
        actor: ownerActor,
        projectId: PROJECT_B,
        principalId: devB,
        role: "owner",
      }),
      "MembershipForbiddenError",
      "owner_role_not_assignable",
    );

    // Cross-project probing by Project A admin on a Project B principal returns MembershipNotFoundError (404).
    yield* expectFailureTag(
      service.setRole({
        actor: adminActor,
        projectId: PROJECT_A,
        principalId: devB,
        role: "viewer",
      }),
      "MembershipNotFoundError",
    );

    // Owner bypasses project membership requirement on Project B, bumps revision + updatedAt, and audits.
    const beforePrincipal = Option.getOrThrow(yield* principals.get(devB));
    yield* TestClock.adjust(Duration.seconds(10));
    const promoted = yield* service.setRole({
      actor: ownerActor,
      projectId: PROJECT_B,
      principalId: devB,
      role: "admin",
    });
    assert.strictEqual(promoted.role, "admin");
    assert.notStrictEqual(promoted.updatedAt, SEED_TIME);

    const afterPrincipal = Option.getOrThrow(yield* principals.get(devB));
    assert.strictEqual(afterPrincipal.accessRevision, beforePrincipal.accessRevision + 1);

    const roleEvents = yield* audit.list({
      action: "membership.role.changed",
      projectId: PROJECT_B,
    });
    assert.strictEqual(roleEvents.length, 1);
    expect(roleEvents[0]!.metadata).toEqual({
      principalId: devB,
      previousRole: "developer",
      role: "admin",
    });
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("suspends and reactivates a membership with revision bumps and audit events", () =>
  Effect.gen(function* () {
    const service = yield* MembershipService.MembershipService;
    const principals = yield* Principals.PrincipalRepository;
    const audit = yield* AuditEvents.AuditEventRepository;

    const devA = PrincipalId.make("dev-a");
    yield* seedMember({ id: devA, displayName: "Dev A", projectId: PROJECT_A, role: "developer" });
    const ownerActor = yield* resolveActor(OWNER_ID);

    const suspended = yield* service.setMembershipState({
      actor: ownerActor,
      projectId: PROJECT_A,
      principalId: devA,
      state: "suspended",
    });
    assert.strictEqual(suspended.state, "suspended");
    assert.strictEqual(Option.getOrThrow(yield* principals.get(devA)).accessRevision, 1);

    const reactivated = yield* service.setMembershipState({
      actor: ownerActor,
      projectId: PROJECT_A,
      principalId: devA,
      state: "active",
    });
    assert.strictEqual(reactivated.state, "active");
    assert.strictEqual(Option.getOrThrow(yield* principals.get(devA)).accessRevision, 2);

    const suspendedEvents = yield* audit.list({ action: "membership.suspended" });
    const reactivatedEvents = yield* audit.list({ action: "member.reactivated" });
    assert.strictEqual(suspendedEvents.length, 1);
    assert.strictEqual(reactivatedEvents.length, 1);
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("promotes owner to admin when the last active admin of a project is removed", () =>
  Effect.gen(function* () {
    const service = yield* MembershipService.MembershipService;
    const principals = yield* Principals.PrincipalRepository;
    const memberships = yield* Memberships.MembershipRepository;
    const audit = yield* AuditEvents.AuditEventRepository;

    const admin1 = PrincipalId.make("admin-1");
    const admin2 = PrincipalId.make("admin-2");
    yield* seedMember({ id: admin1, displayName: "Admin 1", projectId: PROJECT_A, role: "admin" });
    yield* seedMember({ id: admin2, displayName: "Admin 2", projectId: PROJECT_A, role: "admin" });

    const ownerActor = yield* resolveActor(OWNER_ID);
    const ownerRevBefore = Option.getOrThrow(yield* principals.get(OWNER_ID)).accessRevision;

    // Removing one of two admins does not promote owner.
    const firstRemove = yield* service.removeFromProject({
      actor: ownerActor,
      projectId: PROJECT_A,
      principalId: admin1,
    });
    assert.strictEqual(firstRemove.membership.state, "removed");
    assert.isFalse(firstRemove.promotedOwner);
    assert.isTrue(Option.isNone(yield* memberships.get(PROJECT_A, OWNER_ID)));

    // Removing the last active admin promotes owner to active admin and audits it.
    const secondRemove = yield* service.removeFromProject({
      actor: ownerActor,
      projectId: PROJECT_A,
      principalId: admin2,
    });
    assert.strictEqual(secondRemove.membership.state, "removed");
    assert.isTrue(secondRemove.promotedOwner);

    const ownerMembership = Option.getOrThrow(yield* memberships.get(PROJECT_A, OWNER_ID));
    assert.strictEqual(ownerMembership.role, "admin");
    assert.strictEqual(ownerMembership.state, "active");
    assert.strictEqual(
      Option.getOrThrow(yield* principals.get(OWNER_ID)).accessRevision,
      ownerRevBefore + 1,
    );

    const removedEvents = yield* audit.list({ action: "membership.removed" });
    assert.strictEqual(removedEvents.length, 2);
    const promotionEvents = yield* audit.list({ action: "membership.role.changed" });
    assert.strictEqual(promotionEvents.length, 1);
    expect(promotionEvents[0]!.metadata).toEqual({
      principalId: OWNER_ID,
      previousRole: null,
      role: "admin",
      reason: "last_admin_removed",
    });
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("removes a principal, revoking sessions and API tokens, and protects the owner", () =>
  Effect.gen(function* () {
    const service = yield* MembershipService.MembershipService;
    const principals = yield* Principals.PrincipalRepository;
    const memberships = yield* Memberships.MembershipRepository;
    const sessionStore = yield* SessionStore.SessionStore;
    const sessionPrincipals = yield* SessionPrincipals.SessionPrincipalRepository;
    const apiTokens = yield* ApiTokens.ApiTokenRepository;
    const audit = yield* AuditEvents.AuditEventRepository;

    const target = PrincipalId.make("member-to-remove");
    yield* seedMember({
      id: target,
      displayName: "Bob Builder",
      projectId: PROJECT_A,
      role: "admin",
    });

    const issuedSession = yield* sessionStore.issue({
      method: "browser-session-cookie",
      subject: `principal:${target}`,
      scopes: roleScopes("admin"),
      principalId: target,
      binding: { _tag: "principal" },
    });
    yield* apiTokens.create({
      id: ApiTokenId.make("tok-1"),
      principalId: target,
      tokenHmac: "hmac-tok-1",
      scopes: [...roleScopes("developer")],
      binding: { _tag: "principal" },
      expiresAt: null,
      createdAt: SEED_TIME,
    });

    const ownerActor = yield* resolveActor(OWNER_ID);
    const memberActor = yield* resolveActor(target);

    // Non-owner cannot remove a principal; owner cannot remove owner.
    yield* expectFailureTag(
      service.removePrincipal({ actor: memberActor, principalId: target }),
      "MembershipForbiddenError",
      "owner_required",
    );
    yield* expectFailureTag(
      service.removePrincipal({ actor: ownerActor, principalId: OWNER_ID }),
      "MembershipForbiddenError",
      "owner_protected",
    );

    const removed = yield* service.removePrincipal({ actor: ownerActor, principalId: target });
    assert.strictEqual(removed.principal.status, "removed");
    assert.isNotNull(removed.principal.removedAt);
    assert.strictEqual(removed.principal.accessRevision, 1);
    assert.strictEqual(removed.revokedSessions, 1);
    assert.strictEqual(removed.revokedTokens, 1);

    // Session token is revoked and session_principals rows are deleted.
    assert.deepStrictEqual(yield* sessionPrincipals.listForPrincipal(target), []);
    const verifyExit = yield* sessionStore.verify(issuedSession.token).pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(verifyExit));

    // API tokens are revoked.
    const tokens = yield* apiTokens.listForPrincipal(target);
    assert.strictEqual(tokens.length, 1);
    assert.isNotNull(tokens[0]!.revokedAt);

    // Membership is removed and owner was promoted as last admin on PROJECT_A.
    const targetMembership = Option.getOrThrow(yield* memberships.get(PROJECT_A, target));
    assert.strictEqual(targetMembership.state, "removed");
    const ownerMembership = Option.getOrThrow(yield* memberships.get(PROJECT_A, OWNER_ID));
    assert.strictEqual(ownerMembership.role, "admin");
    assert.strictEqual(ownerMembership.state, "active");

    const storedPrincipal = Option.getOrThrow(yield* principals.get(target));
    assert.strictEqual(storedPrincipal.status, "removed");
    assert.isNotNull(storedPrincipal.removedAt);
    assert.strictEqual(storedPrincipal.accessRevision, 1);

    const removedEvents = yield* audit.list({ action: "member.removed" });
    assert.strictEqual(removedEvents.length, 1);
    expect(removedEvents[0]!.metadata).toEqual({
      principalId: target,
      displayName: "Bob Builder",
      revokedTokens: 1,
    });
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("sets principal ceiling and suspends principal (owner-only, revoking sessions)", () =>
  Effect.gen(function* () {
    const service = yield* MembershipService.MembershipService;
    const principals = yield* Principals.PrincipalRepository;
    const memberships = yield* Memberships.MembershipRepository;
    const sessionStore = yield* SessionStore.SessionStore;
    const sessionPrincipals = yield* SessionPrincipals.SessionPrincipalRepository;
    const audit = yield* AuditEvents.AuditEventRepository;

    const target = PrincipalId.make("member-target");
    yield* seedMember({
      id: target,
      displayName: "Carol",
      projectId: PROJECT_A,
      role: "developer",
    });
    yield* memberships.upsert({
      projectId: PROJECT_B,
      principalId: target,
      role: "viewer",
      state: "active",
      invitedBy: OWNER_ID,
      expiresAt: null,
      updatedAt: SEED_TIME,
    });
    const issued = yield* sessionStore.issue({
      method: "browser-session-cookie",
      subject: `principal:${target}`,
      scopes: roleScopes("developer"),
      principalId: target,
      binding: { _tag: "principal" },
    });

    const ownerActor = yield* resolveActor(OWNER_ID);
    const memberActor = yield* resolveActor(target);

    // Non-owner cannot setCeiling or suspendPrincipal.
    yield* expectFailureTag(
      service.setCeiling({ actor: memberActor, principalId: target, template: "restricted" }),
      "MembershipForbiddenError",
      "owner_required",
    );
    yield* expectFailureTag(
      service.suspendPrincipal({ actor: memberActor, principalId: target }),
      "MembershipForbiddenError",
      "owner_required",
    );

    // Owner updates ceiling.
    const updated = yield* service.setCeiling({
      actor: ownerActor,
      principalId: target,
      template: "client",
    });
    assert.deepStrictEqual(updated.ceiling, [...ceilingScopes("client")]);
    assert.strictEqual(updated.accessRevision, 1);

    // Owner suspends principal -> all memberships suspended, sessions revoked, revision bumped.
    const suspended = yield* service.suspendPrincipal({ actor: ownerActor, principalId: target });
    assert.strictEqual(suspended.principal.status, "suspended");
    assert.strictEqual(suspended.principal.accessRevision, 2);
    assert.strictEqual(suspended.suspendedMemberships, 2);
    assert.strictEqual(suspended.revokedSessions, 1);

    const storedMemberships = yield* memberships.listForPrincipal(target);
    assert.isTrue(storedMemberships.every((row) => row.state === "suspended"));
    assert.deepStrictEqual(yield* sessionPrincipals.listForPrincipal(target), []);
    assert.isTrue(Exit.isFailure(yield* sessionStore.verify(issued.token).pipe(Effect.exit)));
    assert.strictEqual(Option.getOrThrow(yield* principals.get(target)).accessRevision, 2);

    const suspendEvents = yield* audit.list({ action: "member.suspended" });
    assert.strictEqual(suspendEvents.length, 1);
    const ceilingEvents = yield* audit.list({ action: "membership.role.changed" });
    assert.strictEqual(ceilingEvents.length, 1);
    expect(ceilingEvents[0]!.metadata).toMatchObject({
      principalId: target,
      change: "ceiling",
      template: "client",
    });

    // Owner reactivates principal -> principal + suspended memberships become active, revision bumps.
    yield* expectFailureTag(
      service.reactivatePrincipal({ actor: memberActor, principalId: target }),
      "MembershipForbiddenError",
      "owner_required",
    );
    const reactivated = yield* service.reactivatePrincipal({
      actor: ownerActor,
      principalId: target,
    });
    assert.strictEqual(reactivated.principal.status, "active");
    assert.strictEqual(reactivated.principal.accessRevision, 3);
    assert.strictEqual(reactivated.reactivatedMemberships, 2);
    assert.isTrue(
      (yield* memberships.listForPrincipal(target)).every((row) => row.state === "active"),
    );
    const reactivateEvents = yield* audit.list({ action: "member.reactivated" });
    assert.strictEqual(reactivateEvents.length, 1);
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("enforces invites/hour rate limit via canIssueInvite and InvitationService.issue", () =>
  Effect.gen(function* () {
    const membershipService = yield* MembershipService.MembershipService;
    const invitationService = yield* InvitationService.InvitationService;
    const memberLimits = yield* MemberLimits.MemberLimitsRepository;

    // Default limit is 10 invites per hour.
    for (let index = 0; index < 10; index += 1) {
      assert.isTrue(yield* membershipService.canIssueInvite(OWNER_ID));
      yield* invitationService.issue({
        role: "viewer",
        projectId: PROJECT_A,
        createdBy: OWNER_ID,
      });
    }
    assert.isFalse(yield* membershipService.canIssueInvite(OWNER_ID));
    yield* expectFailureTag(
      invitationService.issue({
        role: "viewer",
        projectId: PROJECT_A,
        createdBy: OWNER_ID,
      }),
      "InvitationRateLimitedError",
    );

    // After 1 hour, issuing is allowed again and respects per-member overrides.
    yield* TestClock.adjust(Duration.hours(1));
    assert.isTrue(yield* membershipService.canIssueInvite(OWNER_ID));

    yield* memberLimits.set({
      principalId: OWNER_ID,
      maxSessions: null,
      maxTerminals: null,
      invitesPerHour: 2,
      maxApiTokens: null,
    });
    yield* invitationService.issue({ role: "viewer", projectId: PROJECT_A, createdBy: OWNER_ID });
    yield* invitationService.issue({ role: "viewer", projectId: PROJECT_A, createdBy: OWNER_ID });
    assert.isFalse(yield* membershipService.canIssueInvite(OWNER_ID));
    yield* expectFailureTag(
      invitationService.issue({ role: "viewer", projectId: PROJECT_A, createdBy: OWNER_ID }),
      "InvitationRateLimitedError",
    );
  }).pipe(Effect.provide(makeTestLayer())),
);
