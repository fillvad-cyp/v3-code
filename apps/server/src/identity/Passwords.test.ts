import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ApiTokenId,
  AuthAdministrativeClientScopes,
  AuthSessionId,
  PrincipalId,
  ProjectId,
  ceilingScopes,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectAccess from "../access/ProjectAccess.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as PairingGrantStore from "../auth/PairingGrantStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ApiTokens from "../persistence/ApiTokens.ts";
import * as AuditEvents from "../persistence/AuditEvents.ts";
import * as Invitations from "../persistence/Invitations.ts";
import * as MemberLimits from "../persistence/MemberLimits.ts";
import * as Memberships from "../persistence/Memberships.ts";
import * as Principals from "../persistence/Principals.ts";
import * as RecoveryCodes from "../persistence/RecoveryCodes.ts";
import * as SessionPrincipals from "../persistence/SessionPrincipals.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as InvitationService from "./InvitationService.ts";
import * as Passwords from "./Passwords.ts";

const OWNER_ID = InvitationService.OWNER_PRINCIPAL_ID;
const ALICE_ID = PrincipalId.make("alice");
const BOB_ID = PrincipalId.make("bob");
const PROJECT_A = ProjectId.make("project-a");

const ownerActor: ProjectAccess.AccessActor = {
  sessionId: AuthSessionId.make("owner-session"),
  subject: "principal:owner",
  scopes: AuthAdministrativeClientScopes,
  principalId: OWNER_ID,
  binding: { _tag: "environment" },
  isOwner: true,
  roles: new Map(),
};

const memberActor = (principalId: PrincipalId): ProjectAccess.AccessActor => ({
  sessionId: AuthSessionId.make(`session-${principalId}`),
  subject: `principal:${principalId}`,
  scopes: ceilingScopes("staff"),
  principalId,
  binding: { _tag: "principal" },
  isOwner: false,
  ceiling: ceilingScopes("staff"),
  roles: new Map([[PROJECT_A, "developer"]]),
});

const makeTestLayer = () => {
  const config = ServerConfig.layerTest(process.cwd(), { prefix: "t3-passwords-test-" });
  const sqlite = Sqlite.layerMemory;
  const secrets = ServerSecretStore.layer.pipe(Layer.provide(config));
  const repos = Layer.mergeAll(
    Principals.layer,
    Memberships.layer,
    Invitations.layer,
    AuditEvents.layer,
    ApiTokens.layer,
    MemberLimits.layer,
    RecoveryCodes.layer,
    SessionPrincipals.layer,
  ).pipe(Layer.provide(sqlite));
  const auth = EnvironmentAuth.layer.pipe(
    Layer.provide(ServerSettings.layerTest({ multiUser: true })),
    Layer.provide(repos),
    Layer.provide(ManagedPolicy.layerTest()),
    Layer.provideMerge(sqlite),
    Layer.provideMerge(secrets),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(config),
  );
  const access = ProjectAccess.layer.pipe(
    Layer.provide(repos),
    Layer.provide(ProjectStore.layer),
    Layer.provide(sqlite),
  );
  const passwords = Passwords.layer.pipe(
    Layer.provide(repos),
    Layer.provide(auth),
    Layer.provide(sqlite),
    Layer.provide(secrets),
  );
  return Layer.mergeAll(passwords, repos, auth, access, sqlite, secrets).pipe(
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
};

const seedMember = (input: {
  readonly id: PrincipalId;
  readonly displayName: string;
  readonly email: string | null;
  readonly status?: "active" | "suspended";
}) =>
  Effect.gen(function* () {
    const principals = yield* Principals.PrincipalRepository;
    const memberships = yield* Memberships.MembershipRepository;
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    yield* principals.create({
      id: input.id,
      kind: "member",
      displayName: input.displayName,
      email: input.email,
      status: input.status ?? "active",
      ceiling: [...ceilingScopes("staff")],
      createdAt: nowIso,
    });
    yield* memberships.upsert({
      projectId: PROJECT_A,
      principalId: input.id,
      role: "developer",
      state: "active",
      invitedBy: OWNER_ID,
      expiresAt: null,
      updatedAt: nowIso,
    });
  });

describe("Passwords crypto helpers", () => {
  it.effect("hashes with scrypt (32-byte salt) and verifies in constant time", () =>
    Effect.gen(function* () {
      const first = yield* Passwords.hashPassword("correct-horse-battery-staple");
      const second = yield* Passwords.hashPassword("correct-horse-battery-staple");

      assert.strictEqual(first.algo, "scrypt");
      assert.strictEqual(first.salt.length, Passwords.SCRYPT_PARAMS.saltBytes * 2);
      assert.strictEqual(first.hash.length, Passwords.SCRYPT_PARAMS.keylen * 2);
      assert.notStrictEqual(first.salt, second.salt);
      assert.notStrictEqual(first.hash, second.hash);

      assert.isTrue(yield* Passwords.verifyPasswordHash("correct-horse-battery-staple", first));
      assert.isTrue(yield* Passwords.verifyPasswordHash("correct-horse-battery-staple", second));
      assert.isFalse(yield* Passwords.verifyPasswordHash("wrong-password-1234", first));

      // Single-character flip in stored hash and invalid algo/length are rejected safely.
      const flippedHash = (first.hash[0] === "0" ? "1" : "0") + first.hash.slice(1);
      assert.isFalse(
        yield* Passwords.verifyPasswordHash("correct-horse-battery-staple", {
          ...first,
          hash: flippedHash,
        }),
      );
      assert.isFalse(
        yield* Passwords.verifyPasswordHash("correct-horse-battery-staple", {
          ...first,
          algo: "bcrypt",
        }),
      );
      assert.isFalse(
        yield* Passwords.verifyPasswordHash("correct-horse-battery-staple", {
          ...first,
          hash: first.hash.slice(0, 10),
        }),
      );
    }),
  );
});

describe("Passwords service", () => {
  it.effect("sets own password, allows owner to set member password, and verifies login", () =>
    Effect.gen(function* () {
      const passwords = yield* Passwords.Passwords;
      const principals = yield* Principals.PrincipalRepository;
      yield* seedMember({ id: ALICE_ID, displayName: "Alice", email: "alice@example.com" });
      yield* seedMember({ id: BOB_ID, displayName: "Bob", email: "bob@example.com" });

      // Short password rejected.
      const shortExit = yield* Effect.exit(
        passwords.setOwnPassword({ actor: memberActor(ALICE_ID), password: "short" }),
      );
      assert.isTrue(Exit.isFailure(shortExit));

      // Non-owner cannot set another member's password.
      const forbiddenExit = yield* Effect.exit(
        passwords.setMemberPassword({
          actor: memberActor(ALICE_ID),
          principalId: BOB_ID,
          password: "bob-password-1234",
        }),
      );
      assert.isTrue(Exit.isFailure(forbiddenExit));

      // Self sets password.
      const ownResult = yield* passwords.setOwnPassword({
        actor: memberActor(ALICE_ID),
        password: "alice-secret-password",
      });
      assert.deepStrictEqual(ownResult, { updated: true });

      const stored = yield* principals.getCredential(ALICE_ID);
      assert.isTrue(Option.isSome(stored));

      // Owner sets password for Bob.
      yield* passwords.setMemberPassword({
        actor: ownerActor,
        principalId: BOB_ID,
        password: "bob-secret-password",
      });

      // Login by email (case-insensitive) and by principalId.
      const byEmail = yield* passwords.verifyLogin({
        email: "ALICE@EXAMPLE.COM",
        password: "alice-secret-password",
        audit: { ip: "127.0.0.1" },
      });
      assert.strictEqual(byEmail.principal.id, ALICE_ID);
      assert.strictEqual(byEmail.memberships.length, 1);

      const byId = yield* passwords.verifyLogin({
        principalId: BOB_ID,
        password: "bob-secret-password",
        audit: { ip: "127.0.0.1" },
      });
      assert.strictEqual(byId.principal.id, BOB_ID);
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "returns identical errors for unknown/wrong logins and rate limits 5 failures / 15 min",
    () =>
      Effect.gen(function* () {
        const passwords = yield* Passwords.Passwords;
        yield* seedMember({ id: ALICE_ID, displayName: "Alice", email: "alice@example.com" });
        yield* passwords.setOwnPassword({
          actor: memberActor(ALICE_ID),
          password: "alice-secret-password",
        });

        const unknownError = yield* passwords
          .verifyLogin({
            email: "nobody@example.com",
            password: "any-password-1234",
            audit: { ip: "10.0.0.1" },
          })
          .pipe(Effect.flip);
        assert.strictEqual(unknownError._tag, "PasswordAuthFailedError");
        assert.strictEqual(unknownError.message, Passwords.INVALID_CREDENTIALS_MESSAGE);

        // 5 failed attempts for alice@example.com from 10.0.0.2 all return PasswordAuthFailedError.
        for (let attempt = 0; attempt < Passwords.LOGIN_RATE_LIMIT_MAX_FAILURES; attempt += 1) {
          const err = yield* passwords
            .verifyLogin({
              email: "alice@example.com",
              password: "wrong-password-1234",
              audit: { ip: "10.0.0.2" },
            })
            .pipe(Effect.flip);
          assert.strictEqual(err._tag, "PasswordAuthFailedError");
          assert.strictEqual(err.message, unknownError.message);
        }

        // 6th attempt from same email+IP is rate limited even with the correct password.
        const limited = yield* passwords
          .verifyLogin({
            email: "alice@example.com",
            password: "alice-secret-password",
            audit: { ip: "10.0.0.2" },
          })
          .pipe(Effect.flip);
        assert.strictEqual(limited._tag, "PasswordRateLimitedError");

        // Different IP is not rate limited.
        const otherIp = yield* passwords.verifyLogin({
          email: "alice@example.com",
          password: "alice-secret-password",
          audit: { ip: "10.0.0.3" },
        });
        assert.strictEqual(otherIp.principal.id, ALICE_ID);

        // Advancing the clock past 15 minutes clears the rate-limit window.
        yield* TestClock.adjust(Duration.minutes(16));
        const afterWindow = yield* passwords.verifyLogin({
          email: "alice@example.com",
          password: "alice-secret-password",
          audit: { ip: "10.0.0.2" },
        });
        assert.strictEqual(afterWindow.principal.id, ALICE_ID);
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "recovery code is single-use, expires after 15 min, revokes sessions/devices/PATs, and audits",
    () =>
      Effect.gen(function* () {
        const passwords = yield* Passwords.Passwords;
        const sessions = yield* SessionStore.SessionStore;
        const pairingGrants = yield* PairingGrantStore.PairingGrantStore;
        const apiTokens = yield* ApiTokens.ApiTokenRepository;
        const auditEvents = yield* AuditEvents.AuditEventRepository;

        yield* seedMember({ id: ALICE_ID, displayName: "Alice", email: "alice@example.com" });
        yield* passwords.setOwnPassword({
          actor: memberActor(ALICE_ID),
          password: "old-password-1234",
        });

        // Expired recovery code fails after 15 minutes.
        const expiredIssued = yield* passwords.issueRecoveryCode({
          actor: ownerActor,
          principalId: ALICE_ID,
        });
        yield* TestClock.adjust(Duration.minutes(16));
        const expiredErr = yield* passwords
          .confirmRecovery({
            code: expiredIssued.code,
            password: "new-password-5678",
          })
          .pipe(Effect.flip);
        assert.strictEqual(expiredErr._tag, "PasswordRecoveryExpiredError");

        // Seed an active session with a trusted Connect device and an API token for Alice.
        const deviceThumbprint = "alice-device-thumbprint-001";
        yield* pairingGrants.trustConnectDevice(deviceThumbprint, {
          deviceType: "desktop",
          label: "Alice Laptop",
        });
        const aliceSession = yield* sessions.issue({
          method: "dpop-access-token",
          subject: `principal:${ALICE_ID}`,
          scopes: ceilingScopes("staff"),
          principalId: ALICE_ID,
          binding: { _tag: "principal" },
          proofKeyThumbprint: deviceThumbprint,
          client: { deviceType: "desktop", label: "Alice Laptop" },
        });
        const nowIso = DateTime.formatIso(yield* DateTime.now);
        yield* apiTokens.create({
          id: ApiTokenId.make("tok-alice-1"),
          principalId: ALICE_ID,
          tokenHmac: "hmac-alice-token-1",
          scopes: [...ceilingScopes("staff")],
          binding: { _tag: "principal" },
          expiresAt: null,
          createdAt: nowIso,
        });

        // Issue fresh recovery code and confirm it.
        const freshIssued = yield* passwords.issueRecoveryCode({
          actor: memberActor(ALICE_ID),
        });
        assert.strictEqual(freshIssued.principalId, ALICE_ID);

        const confirmed = yield* passwords.confirmRecovery({
          code: freshIssued.code,
          password: "brand-new-password-9999",
          audit: { ip: "127.0.0.1" },
        });
        assert.strictEqual(confirmed.recovered, true);
        assert.strictEqual(confirmed.principalId, ALICE_ID);
        assert.strictEqual(confirmed.revokedSessions, 1);
        assert.strictEqual(confirmed.revokedDevices, 1);
        assert.strictEqual(confirmed.revokedTokens, 1);

        // Reusing the same recovery code fails as already used.
        const reuseErr = yield* passwords
          .confirmRecovery({
            code: freshIssued.code,
            password: "another-password-1111",
          })
          .pipe(Effect.flip);
        assert.strictEqual(reuseErr._tag, "PasswordRecoveryAlreadyUsedError");

        // Previous session, trusted device, and PAT are all revoked.
        const verifyOldSession = yield* Effect.exit(sessions.verify(aliceSession.token));
        assert.isTrue(Exit.isFailure(verifyOldSession));
        assert.isFalse(yield* pairingGrants.isConnectDeviceTrusted(deviceThumbprint));
        const tokensAfter = yield* apiTokens.listForPrincipal(ALICE_ID);
        assert.isNotNull(tokensAfter[0]?.revokedAt);

        // New password works and old password fails.
        const oldLogin = yield* Effect.exit(
          passwords.verifyLogin({
            principalId: ALICE_ID,
            password: "old-password-1234",
          }),
        );
        assert.isTrue(Exit.isFailure(oldLogin));
        const newLogin = yield* passwords.verifyLogin({
          principalId: ALICE_ID,
          password: "brand-new-password-9999",
        });
        assert.strictEqual(newLogin.principal.id, ALICE_ID);

        // member.recovered audit event recorded.
        const events = yield* auditEvents.list({ action: "member.recovered" });
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0]!.resourceId, ALICE_ID);
        assert.strictEqual(events[0]!.outcome, "allow");
      }).pipe(Effect.provide(makeTestLayer())),
  );
});
