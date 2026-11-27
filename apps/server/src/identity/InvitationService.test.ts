import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import {
  InvitationId,
  PrincipalId,
  ProjectId,
  ceilingScopes,
  intersectScopes,
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
import * as InvitationCodes from "./InvitationCodes.ts";
import * as InvitationService from "./InvitationService.ts";
import * as MembershipService from "./MembershipService.ts";

const OWNER = InvitationService.OWNER_PRINCIPAL_ID;
const PROJECT_A = ProjectId.make("project-a");
const PROJECT_B = ProjectId.make("project-b");

const makeTestLayer = () => {
  const config = ServerConfig.layerTest(process.cwd(), { prefix: "t3-invitation-service-test-" });
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
  const service = InvitationService.layer.pipe(
    Layer.provide(membershipService),
    Layer.provide(access),
    Layer.provide(repos),
    Layer.provide(secrets),
  );
  return Layer.mergeAll(service, membershipService, access, repos, secrets, sessions).pipe(
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
};

it.effect("generates Crockford-style codes and verifies HMAC hashes", () =>
  Effect.gen(function* () {
    const codes = yield* InvitationCodes.make();
    const { code, tokenHash } = yield* codes.generate();

    expect(code).toMatch(
      /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/,
    );
    expect(code).not.toMatch(/[01IO]/);
    expect(tokenHash).not.toContain(code);
    assert.isTrue(yield* codes.verify(code, tokenHash));
    assert.isTrue(yield* codes.verify(code.toLowerCase().replaceAll("-", " "), tokenHash));
    assert.isFalse(yield* codes.verify("AAAA-AAAA-AAAA", tokenHash));
    assert.isFalse(yield* codes.verify("0000-1111-OOOO", tokenHash));
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("issues and consumes an invitation, creating an active principal and membership", () =>
  Effect.gen(function* () {
    const service = yield* InvitationService.InvitationService;
    const invitations = yield* Invitations.InvitationRepository;
    const principals = yield* Principals.PrincipalRepository;
    const memberships = yield* Memberships.MembershipRepository;
    const audit = yield* AuditEvents.AuditEventRepository;

    const issued = yield* service.issue({
      kind: "staff",
      role: "developer",
      projectId: PROJECT_A,
      createdBy: OWNER,
    });

    assert.strictEqual(issued.invitation.role, "developer");
    assert.strictEqual(issued.invitation.projectId, PROJECT_A);
    assert.strictEqual(issued.invitation.createdBy, OWNER);
    assert.deepStrictEqual(issued.invitation.ceiling, [...ceilingScopes("staff")]);

    // Raw code is never stored in the database.
    assert.isTrue(Option.isNone(yield* invitations.getByTokenHash(issued.code)));

    const pendingBefore = yield* service.listPending({ actorId: OWNER });
    assert.deepStrictEqual(
      pendingBefore.map((row) => row.id),
      [issued.invitation.id],
    );

    const consumed = yield* service.consume({
      code: issued.code.toLowerCase(),
      displayName: "  Ada Lovelace  ",
    });

    assert.strictEqual(consumed.principal.kind, "member");
    assert.strictEqual(consumed.principal.status, "active");
    assert.strictEqual(consumed.principal.displayName, "Ada Lovelace");
    assert.deepStrictEqual(consumed.principal.ceiling, [...ceilingScopes("staff")]);
    assert.strictEqual(consumed.memberships.length, 1);
    assert.strictEqual(consumed.memberships[0]!.projectId, PROJECT_A);
    assert.strictEqual(consumed.memberships[0]!.role, "developer");
    assert.strictEqual(consumed.memberships[0]!.state, "active");
    assert.strictEqual(consumed.memberships[0]!.invitedBy, OWNER);

    const storedPrincipal = Option.getOrThrow(yield* principals.get(consumed.principal.id));
    assert.strictEqual(storedPrincipal.status, "active");
    const storedMembership = Option.getOrThrow(
      yield* memberships.get(PROJECT_A, consumed.principal.id),
    );
    assert.strictEqual(storedMembership.role, "developer");
    assert.strictEqual(storedMembership.state, "active");

    assert.deepStrictEqual(yield* service.listPending({ actorId: OWNER }), []);

    const events = yield* audit.list({});
    assert.deepStrictEqual(events.map((event) => event.action).sort(), [
      "invitation.accepted",
      "invitation.created",
    ]);
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("rejects double consumption of the same invitation code", () =>
  Effect.gen(function* () {
    const service = yield* InvitationService.InvitationService;
    const issued = yield* service.issue({
      kind: "staff",
      role: "operator",
      projectId: PROJECT_A,
      createdBy: OWNER,
    });

    yield* service.consume({ code: issued.code, displayName: "First" });

    const second = yield* service
      .consume({ code: issued.code, displayName: "Second" })
      .pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(second));
    if (Exit.isFailure(second)) {
      const error = second.cause.reasons[0];
      assert.strictEqual(error?._tag, "Fail");
      if (error?._tag === "Fail") {
        assert.strictEqual(error.error._tag, "InvitationAlreadyUsedError");
      }
    }
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("rejects consuming an expired invitation", () =>
  Effect.gen(function* () {
    const service = yield* InvitationService.InvitationService;
    const issued = yield* service.issue({
      kind: "staff",
      role: "viewer",
      projectId: PROJECT_A,
      createdBy: OWNER,
      ttl: Duration.minutes(5),
    });

    yield* TestClock.adjust(Duration.minutes(6));

    const result = yield* service
      .consume({ code: issued.code, displayName: "Latecomer" })
      .pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(result));
    if (Exit.isFailure(result)) {
      const error = result.cause.reasons[0];
      assert.strictEqual(error?._tag, "Fail");
      if (error?._tag === "Fail") {
        assert.strictEqual(error.error._tag, "InvitationExpiredError");
      }
    }
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("revokes an invitation, audits it, and blocks consumption", () =>
  Effect.gen(function* () {
    const service = yield* InvitationService.InvitationService;
    const audit = yield* AuditEvents.AuditEventRepository;

    const issued = yield* service.issue({
      kind: "staff",
      role: "developer",
      projectId: PROJECT_A,
      createdBy: OWNER,
    });

    assert.isTrue(yield* service.revoke({ id: issued.invitation.id, revokedBy: OWNER }));
    assert.isFalse(yield* service.revoke({ id: issued.invitation.id, revokedBy: OWNER }));
    assert.deepStrictEqual(yield* service.listPending({ actorId: OWNER }), []);

    const attempt = yield* service
      .consume({ code: issued.code, displayName: "Blocked" })
      .pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(attempt));
    if (Exit.isFailure(attempt)) {
      const error = attempt.cause.reasons[0];
      assert.strictEqual(error?._tag, "Fail");
      if (error?._tag === "Fail") {
        assert.strictEqual(error.error._tag, "InvitationInvalidError");
        if (error.error._tag === "InvitationInvalidError") {
          assert.strictEqual(error.error.reason, "revoked");
        }
      }
    }

    const revokedEvents = yield* audit.list({ action: "invitation.revoked" });
    assert.strictEqual(revokedEvents.length, 1);
    assert.strictEqual(revokedEvents[0]!.resourceId, issued.invitation.id);
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("enforces owner vs project admin rules for issuing, listing, and revoking", () =>
  Effect.gen(function* () {
    const service = yield* InvitationService.InvitationService;
    const principals = yield* Principals.PrincipalRepository;
    const memberships = yield* Memberships.MembershipRepository;
    const now = "2026-11-25T00:00:00.000Z";

    const adminA = PrincipalId.make("admin-a");
    const restrictedAdminA = PrincipalId.make("restricted-admin-a");
    const devA = PrincipalId.make("dev-a");

    yield* principals.create({
      id: adminA,
      kind: "member",
      displayName: "Admin A",
      email: null,
      status: "active",
      ceiling: [...ceilingScopes("staff")],
      createdAt: now,
    });
    yield* memberships.upsert({
      projectId: PROJECT_A,
      principalId: adminA,
      role: "admin",
      state: "active",
      invitedBy: OWNER,
      expiresAt: null,
      updatedAt: now,
    });

    yield* principals.create({
      id: restrictedAdminA,
      kind: "member",
      displayName: "Restricted Admin A",
      email: null,
      status: "active",
      ceiling: [...ceilingScopes("restricted")],
      createdAt: now,
    });
    yield* memberships.upsert({
      projectId: PROJECT_A,
      principalId: restrictedAdminA,
      role: "admin",
      state: "active",
      invitedBy: OWNER,
      expiresAt: null,
      updatedAt: now,
    });

    yield* principals.create({
      id: devA,
      kind: "member",
      displayName: "Dev A",
      email: null,
      status: "active",
      ceiling: [...ceilingScopes("staff")],
      createdAt: now,
    });
    yield* memberships.upsert({
      projectId: PROJECT_A,
      principalId: devA,
      role: "developer",
      state: "active",
      invitedBy: OWNER,
      expiresAt: null,
      updatedAt: now,
    });

    const expectForbidden = <A, E>(
      effect: Effect.Effect<A, E>,
      reason?: InvitationService.InvitationForbiddenReason,
    ) =>
      effect.pipe(
        Effect.exit,
        Effect.map((exit) => {
          assert.isTrue(Exit.isFailure(exit));
          if (Exit.isFailure(exit)) {
            const first = exit.cause.reasons[0];
            assert.strictEqual(first?._tag, "Fail");
            if (first?._tag === "Fail") {
              const err = first.error as { readonly _tag?: string; readonly reason?: string };
              assert.strictEqual(err._tag, "InvitationForbiddenError");
              if (reason !== undefined) {
                assert.strictEqual(err.reason, reason);
              }
            }
          }
        }),
      );

    // Owner cannot invite another owner via staff invitation.
    yield* expectForbidden(
      service.issue({ role: "owner", projectId: PROJECT_A, createdBy: OWNER }),
      "owner_role_not_invitable",
    );

    // Owner can issue an environment-wide invitation and a project B invitation.
    const envInvite = yield* service.issue({
      role: "developer",
      projectId: null,
      createdBy: OWNER,
    });
    const projectBInvite = yield* service.issue({
      role: "viewer",
      projectId: PROJECT_B,
      createdBy: OWNER,
    });

    // Project A admin can issue for Project A (up to admin within staff ceiling).
    const projectAInvite = yield* service.issue({
      role: "developer",
      projectId: PROJECT_A,
      createdBy: adminA,
    });
    assert.deepStrictEqual(
      projectAInvite.invitation.ceiling,
      intersectScopes(ceilingScopes("staff"), ceilingScopes("staff")),
    );

    // Project A admin cannot issue environment-wide or for Project B.
    yield* expectForbidden(
      service.issue({ role: "viewer", projectId: null, createdBy: adminA }),
      "environment_invite_requires_owner",
    );
    yield* expectForbidden(
      service.issue({ role: "viewer", projectId: PROJECT_B, createdBy: adminA }),
      "not_authorized",
    );

    // Admin with a restricted ceiling cannot invite a developer (role exceeds ceiling),
    // but can invite an operator whose scopes fit the restricted ceiling.
    yield* expectForbidden(
      service.issue({ role: "developer", projectId: PROJECT_A, createdBy: restrictedAdminA }),
      "ceiling_exceeds_issuer",
    );
    const restrictedInvite = yield* service.issue({
      role: "operator",
      projectId: PROJECT_A,
      createdBy: restrictedAdminA,
    });
    assert.deepStrictEqual(
      [...restrictedInvite.invitation.ceiling].sort(),
      [...ceilingScopes("restricted")].sort(),
    );

    // Non-admin developer cannot issue, list, or revoke.
    yield* expectForbidden(
      service.issue({ role: "viewer", projectId: PROJECT_A, createdBy: devA }),
      "not_authorized",
    );
    yield* expectForbidden(service.listPending({ actorId: devA }), "not_authorized");
    yield* expectForbidden(
      service.revoke({ id: projectAInvite.invitation.id, revokedBy: devA }),
      "invitation_not_in_scope",
    );
    yield* expectForbidden(
      service.revoke({ id: InvitationId.make("missing"), revokedBy: devA }),
      "not_authorized",
    );

    // Listing scope: owner sees all 4; Project A admin sees only Project A's 2.
    assert.strictEqual((yield* service.listPending({ actorId: OWNER })).length, 4);
    const adminVisible = yield* service.listPending({ actorId: adminA });
    assert.deepStrictEqual(
      adminVisible.map((row) => row.id).sort(),
      [projectAInvite.invitation.id, restrictedInvite.invitation.id].sort(),
    );

    // Project A admin cannot revoke Project B or environment invitations, but can revoke Project A's.
    yield* expectForbidden(
      service.revoke({ id: projectBInvite.invitation.id, revokedBy: adminA }),
      "invitation_not_in_scope",
    );
    yield* expectForbidden(
      service.revoke({ id: envInvite.invitation.id, revokedBy: adminA }),
      "invitation_not_in_scope",
    );
    assert.isTrue(yield* service.revoke({ id: projectAInvite.invitation.id, revokedBy: adminA }));
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("issues 15-minute single-use login codes with owner/self auth and rate limits", () =>
  Effect.gen(function* () {
    const service = yield* InvitationService.InvitationService;
    const principals = yield* Principals.PrincipalRepository;
    const memberLimits = yield* MemberLimits.MemberLimitsRepository;

    const invited = yield* service.issue({
      kind: "staff",
      role: "developer",
      projectId: PROJECT_A,
      createdBy: OWNER,
    });
    const accepted = yield* service.consume({ code: invited.code, displayName: "Grace Hopper" });
    const memberId = accepted.principal.id;

    // Owner issues login code for member; consuming logs existing principal in without creating a duplicate.
    const ownerIssued = yield* service.issueLogin(memberId);
    assert.strictEqual(ownerIssued.invitation.kind, "staff");
    assert.strictEqual(ownerIssued.invitation.projectId, null);
    assert.strictEqual(ownerIssued.invitation.principalId, memberId);

    const beforeCount = (yield* principals.list).length;
    const loggedIn = yield* service.consume({ code: ownerIssued.code });
    assert.strictEqual(loggedIn.principal.id, memberId);
    assert.strictEqual(loggedIn.principal.displayName, "Grace Hopper");
    assert.strictEqual((yield* principals.list).length, beforeCount);

    // Single-use: consuming the same login code again fails with InvitationAlreadyUsedError.
    const replay = yield* service.consume({ code: ownerIssued.code }).pipe(Effect.flip);
    assert.strictEqual(replay._tag, "InvitationAlreadyUsedError");

    // Member can issue a login code for herself, but not for another principal.
    const selfIssued = yield* service.issueLogin({ principalId: memberId, createdBy: memberId });
    assert.strictEqual(selfIssued.invitation.principalId, memberId);

    const forbidden = yield* service
      .issueLogin({ principalId: OWNER, createdBy: memberId })
      .pipe(Effect.flip);
    assert.strictEqual(forbidden._tag, "InvitationForbiddenError");

    // Rate-limited by invites_per_hour limit.
    yield* memberLimits.set({
      principalId: memberId,
      maxSessions: null,
      maxTerminals: null,
      invitesPerHour: 1,
      maxApiTokens: null,
    });
    const limited = yield* service
      .issueLogin({ principalId: memberId, createdBy: memberId })
      .pipe(Effect.flip);
    assert.strictEqual(limited._tag, "InvitationRateLimitedError");

    // Default login code TTL is 15 minutes.
    yield* TestClock.adjust(Duration.minutes(16));
    const expired = yield* service.consume({ code: selfIssued.code }).pipe(Effect.flip);
    assert.strictEqual(expired._tag, "InvitationExpiredError");
  }).pipe(Effect.provide(makeTestLayer())),
);
