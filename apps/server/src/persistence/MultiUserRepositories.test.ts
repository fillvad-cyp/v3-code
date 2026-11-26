import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ApiTokenId,
  AuthSessionId,
  InvitationId,
  PrincipalId,
  ProjectId,
  type AppendAuditEventInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ApiTokens from "./ApiTokens.ts";
import * as AuditEvents from "./AuditEvents.ts";
import * as MemberLimits from "./MemberLimits.ts";
import * as Memberships from "./Memberships.ts";
import * as Invitations from "./Invitations.ts";
import * as Principals from "./Principals.ts";
import * as ProjectQuotas from "./ProjectQuotas.ts";
import * as SessionPrincipals from "./SessionPrincipals.ts";
import * as Sqlite from "./Sqlite.ts";

const owner = PrincipalId.make("owner");
const member = PrincipalId.make("member-1");
const project = ProjectId.make("web");
const at = (iso: string) => iso;

const setup = Effect.gen(function* () {
  const principals = yield* Principals.PrincipalRepository;
  if (Option.isNone(yield* principals.get(member))) {
    yield* principals.create({
      id: member,
      kind: "member",
      displayName: "Ada",
      email: "ada@example.com",
      status: "invited",
      ceiling: ["orchestration:read"],
      createdAt: at("2026-11-25T00:00:00.000Z"),
    });
  }
  return principals;
});

const repositories = Layer.mergeAll(
  Principals.layer,
  Memberships.layer,
  Invitations.layer,
  ApiTokens.layer,
  AuditEvents.layer,
  ProjectQuotas.layer,
  MemberLimits.layer,
  SessionPrincipals.layer,
);

it.layer(repositories.pipe(Layer.provideMerge(Sqlite.layerMemory)))(
  "multi-user repositories",
  (it) => {
    it.effect("round-trips a principal, its ceiling and its credential", () =>
      Effect.gen(function* () {
        const principals = yield* setup;

        const found = yield* principals.getByEmail("ADA@example.com");
        assert.isTrue(Option.isSome(found));
        assert.deepStrictEqual(Option.getOrThrow(found).ceiling, ["orchestration:read"]);

        yield* principals.setCredential({
          principalId: member,
          salt: "salt",
          hash: "hash",
          updatedAt: at("2026-11-25T00:00:00.000Z"),
        });
        const credential = yield* principals.getCredential(member);
        assert.deepStrictEqual(Option.getOrThrow(credential), {
          algo: "scrypt",
          salt: "salt",
          hash: "hash",
          updatedAt: "2026-11-25T00:00:00.000Z",
        });

        yield* principals.update({
          id: member,
          ceiling: ["orchestration:read", "filesystem:read"],
          status: "active",
          updatedAt: at("2026-11-25T00:01:00.000Z"),
          bumpAccessRevision: true,
        });
        const updated = Option.getOrThrow(yield* principals.get(member));
        assert.deepStrictEqual(updated.ceiling, ["orchestration:read", "filesystem:read"]);
        assert.strictEqual(updated.accessRevision, 1);
        assert.strictEqual(updated.status, "active");
        assert.strictEqual(
          yield* principals.bumpAccessRevision(member, at("2026-11-25T00:02:00.000Z")),
          2,
        );
      }),
    );

    it.effect("moves a membership through roles and states, then deletes it", () =>
      Effect.gen(function* () {
        const memberships = yield* Memberships.MembershipRepository;
        yield* setup;

        yield* memberships.upsert({
          projectId: project,
          principalId: member,
          role: "viewer",
          state: "invited",
          invitedBy: owner,
          expiresAt: null,
          updatedAt: at("2026-11-25T00:00:00.000Z"),
        });
        assert.strictEqual((yield* memberships.listForProject(project)).length, 1);

        assert.isTrue(
          yield* memberships.setRole({
            projectId: project,
            principalId: member,
            role: "developer",
            updatedAt: at("2026-11-25T00:01:00.000Z"),
          }),
        );
        assert.isTrue(
          yield* memberships.setState({
            projectId: project,
            principalId: member,
            state: "suspended",
            updatedAt: at("2026-11-25T00:02:00.000Z"),
          }),
        );
        const membership = Option.getOrThrow(yield* memberships.get(project, member));
        assert.strictEqual(membership.role, "developer");
        assert.strictEqual(membership.state, "suspended");
        assert.strictEqual((yield* memberships.listForPrincipal(member)).length, 1);

        assert.isTrue(yield* memberships.delete(project, member));
        assert.isTrue(Option.isNone(yield* memberships.get(project, member)));
      }),
    );

    it.effect("spends an invitation exactly once and refuses it after it expires", () =>
      Effect.gen(function* () {
        const invitations = yield* Invitations.InvitationRepository;
        yield* setup;
        const now = at("2026-11-25T00:00:00.000Z");

        yield* invitations.create({
          id: InvitationId.make("invite-1"),
          tokenHash: "hash-1",
          email: "ada@example.com",
          kind: "staff",
          role: "viewer",
          projectId: null,
          ceiling: ["orchestration:read"],
          createdBy: owner,
          createdAt: now,
          expiresAt: at("2026-12-02T00:00:00.000Z"),
        });
        yield* invitations.create({
          id: InvitationId.make("invite-2"),
          tokenHash: "hash-2",
          email: null,
          kind: "staff",
          role: "viewer",
          projectId: null,
          ceiling: [],
          createdBy: owner,
          createdAt: now,
          expiresAt: at("2026-11-26T00:00:00.000Z"),
        });

        const consumed = yield* invitations.consume({ tokenHash: "hash-1", now });
        assert.strictEqual(Option.getOrThrow(consumed).acceptedAt, now);
        assert.isTrue(Option.isNone(yield* invitations.consume({ tokenHash: "hash-1", now })));
        assert.isTrue(
          Option.isNone(
            yield* invitations.consume({
              tokenHash: "hash-2",
              now: at("2026-11-27T00:00:00.000Z"),
            }),
          ),
        );

        yield* invitations.create({
          id: InvitationId.make("invite-3"),
          tokenHash: "hash-3",
          email: null,
          kind: "staff",
          role: "viewer",
          projectId: project,
          ceiling: [],
          createdBy: owner,
          createdAt: now,
          expiresAt: at("2026-12-02T00:00:00.000Z"),
        });
        assert.deepStrictEqual(
          (yield* invitations.listPending({ now, projectId: project })).map((row) => row.id),
          ["invite-3"],
        );
        assert.isTrue(
          yield* invitations.revoke({
            id: InvitationId.make("invite-3"),
            revokedAt: now,
          }),
        );
        assert.deepStrictEqual(yield* invitations.listPending({ now, projectId: project }), []);
      }),
    );

    it.effect("stores a token's project binding and revokes them together", () =>
      Effect.gen(function* () {
        const tokens = yield* ApiTokens.ApiTokenRepository;
        yield* setup;
        const id = ApiTokenId.make("token-1");

        yield* tokens.create({
          id,
          principalId: member,
          tokenHmac: "hmac-1",
          scopes: ["orchestration:read"],
          binding: { _tag: "projects", projects: [{ projectId: project, role: "viewer" }] },
          expiresAt: null,
          createdAt: at("2026-11-25T00:00:00.000Z"),
        });
        const token = Option.getOrThrow(yield* tokens.getByHmac("hmac-1"));
        assert.deepStrictEqual(token.binding, {
          _tag: "projects",
          projects: [{ projectId: project, role: "viewer" }],
        });
        assert.isTrue(yield* tokens.touchLastUsed(id, at("2026-11-25T01:00:00.000Z")));
        assert.strictEqual(
          Option.getOrThrow(yield* tokens.getByHmac("hmac-1")).lastUsedAt,
          "2026-11-25T01:00:00.000Z",
        );
        assert.strictEqual(
          yield* tokens.revokeAllForPrincipal(member, at("2026-11-25T02:00:00.000Z")),
          1,
        );
        assert.isTrue(Option.getOrThrow(yield* tokens.getByHmac("hmac-1")).revokedAt !== null);
      }),
    );

    it.effect("appends audit events and filters and prunes them", () =>
      Effect.gen(function* () {
        const audit = yield* AuditEvents.AuditEventRepository;
        const base: AppendAuditEventInput = {
          at: at("2026-11-25T00:00:00.000Z"),
          actorPrincipalId: member,
          actorSessionId: null,
          action: "login.failed",
          resourceType: null,
          resourceId: null,
          projectId: null,
          ip: "127.0.0.1",
          userAgent: null,
          outcome: "deny",
          metadata: { email: "ada@example.com" },
        };
        yield* audit.append(base);
        yield* audit.append({ ...base, at: at("2026-11-25T01:00:00.000Z"), projectId: project });
        yield* audit.append({
          ...base,
          at: at("2026-11-26T00:00:00.000Z"),
          action: "terminal.opened",
        });

        assert.strictEqual((yield* audit.list({})).length, 3);
        const byProject = yield* audit.list({ projectId: project });
        assert.deepStrictEqual(
          byProject.map((event) => event.projectId),
          [project],
        );
        assert.deepStrictEqual(
          yield* audit.list({}).pipe(Effect.map((rows) => rows[0]!.metadata)),
          {
            email: "ada@example.com",
          },
        );
        assert.strictEqual((yield* audit.list({ from: at("2026-11-25T00:30:00.000Z") })).length, 2);
        assert.strictEqual(yield* audit.pruneBefore(at("2026-11-25T00:30:00.000Z")), 1);
      }),
    );

    it.effect("filters audit events by actor, action, projectIds, time range, and id cursor", () =>
      Effect.gen(function* () {
        const audit = yield* AuditEvents.AuditEventRepository;
        const projA = ProjectId.make("audit-repo-a");
        const projB = ProjectId.make("audit-repo-b");
        const projC = ProjectId.make("audit-repo-c");
        const actor1 = PrincipalId.make("audit-actor-1");
        const actor2 = PrincipalId.make("audit-actor-2");
        const template: AppendAuditEventInput = {
          at: at("2026-11-26T00:00:00.000Z"),
          actorPrincipalId: actor1,
          actorSessionId: null,
          action: "login.succeeded",
          resourceType: "session",
          resourceId: "s-1",
          projectId: null,
          ip: "127.0.0.1",
          userAgent: null,
          outcome: "allow",
          metadata: null,
        };

        const id1 = yield* audit.append({
          ...template,
          at: at("2026-11-26T01:00:00.000Z"),
          projectId: projA,
          action: "preview.tunnel.opened",
        });
        const id2 = yield* audit.append({
          ...template,
          at: at("2026-11-26T02:00:00.000Z"),
          actorPrincipalId: actor2,
          projectId: projB,
          action: "secret.read",
        });
        const id3 = yield* audit.append({
          ...template,
          at: at("2026-11-26T03:00:00.000Z"),
          actorPrincipalId: actor1,
          projectId: projA,
          action: "authorization.denied",
          outcome: "deny",
        });
        const id4 = yield* audit.append({
          ...template,
          at: at("2026-11-26T04:00:00.000Z"),
          actorPrincipalId: actor2,
          projectId: projC,
          action: "preview.tunnel.opened",
        });

        assert.deepStrictEqual(
          (yield* audit.list({ projectIds: [projA, projB] })).map((row) => row.id),
          [id3, id2, id1],
        );
        assert.deepStrictEqual(yield* audit.list({ projectIds: [] }), []);
        assert.deepStrictEqual(
          (yield* audit.list({ actorPrincipalId: actor2 })).map((row) => row.id),
          [id4, id2],
        );
        assert.deepStrictEqual(
          (yield* audit.list({ action: "preview.tunnel.opened" })).map((row) => row.id),
          [id4, id1],
        );
        assert.deepStrictEqual(
          (yield* audit.list({
            from: at("2026-11-26T01:30:00.000Z"),
            to: at("2026-11-26T03:30:00.000Z"),
          })).map((row) => row.id),
          [id3, id2],
        );

        // Cursor pagination in descending id order.
        const page1 = yield* audit.list({ projectIds: [projA, projB, projC], limit: 2 });
        assert.deepStrictEqual(
          page1.map((row) => row.id),
          [id4, id3],
        );
        const page2 = yield* audit.list({
          projectIds: [projA, projB, projC],
          cursor: page1[page1.length - 1]!.id,
          limit: 2,
        });
        assert.deepStrictEqual(
          page2.map((row) => row.id),
          [id2, id1],
        );
        const page3 = yield* audit.list({
          projectIds: [projA, projB, projC],
          cursor: page2[page2.length - 1]!.id,
          limit: 2,
        });
        assert.deepStrictEqual(page3, []);
      }),
    );

    it.effect("stores quotas and limits per project and principal", () =>
      Effect.gen(function* () {
        const quotas = yield* ProjectQuotas.ProjectQuotaRepository;
        const limits = yield* MemberLimits.MemberLimitsRepository;
        yield* setup;

        yield* quotas.set({
          projectId: project,
          maxActiveThreads: 10,
          maxWorktrees: null,
          diskBytes: 5_000,
          attachmentBytes: null,
        });
        const quota = yield* quotas.get(project);
        assert.deepStrictEqual(quota, {
          projectId: project,
          maxActiveThreads: 10,
          maxWorktrees: null,
          diskBytes: 5_000,
          attachmentBytes: null,
        });
        assert.isTrue(yield* quotas.remove(project));
        const cleared = yield* quotas.get(project);
        assert.isUndefined(cleared);

        yield* limits.set({
          principalId: member,
          maxSessions: 5,
          maxTerminals: 3,
          invitesPerHour: 10,
          maxApiTokens: null,
        });
        const limitsRow = yield* limits.get(member);
        assert.strictEqual(limitsRow?.maxTerminals, 3);
        const allLimits = yield* limits.list;
        assert.strictEqual(allLimits.length, 1);
        assert.isTrue(yield* limits.remove(member));
      }),
    );

    it.effect("round-trips session principal bindings and removes them", () =>
      Effect.gen(function* () {
        const sessionPrincipals = yield* SessionPrincipals.SessionPrincipalRepository;
        yield* setup;
        const envSession = AuthSessionId.make("sess-env");
        const projectSession = AuthSessionId.make("sess-projects");
        const principalSession = AuthSessionId.make("sess-principal");

        yield* sessionPrincipals.put({
          sessionId: envSession,
          principalId: owner,
          bindingKind: "environment",
        });
        assert.deepStrictEqual(Option.getOrThrow(yield* sessionPrincipals.get(envSession)), {
          principalId: owner,
          bindingKind: "environment",
          binding: undefined,
        });

        const projectsBinding = {
          _tag: "projects" as const,
          projects: [{ projectId: project, role: "developer" as const }],
        };
        yield* sessionPrincipals.put({
          sessionId: projectSession,
          principalId: member,
          bindingKind: "projects",
          binding: projectsBinding,
        });
        assert.deepStrictEqual(Option.getOrThrow(yield* sessionPrincipals.get(projectSession)), {
          principalId: member,
          bindingKind: "projects",
          binding: projectsBinding,
        });

        yield* sessionPrincipals.put({
          sessionId: principalSession,
          principalId: member,
          bindingKind: "principal",
        });
        assert.deepStrictEqual(yield* sessionPrincipals.listForPrincipal(member), [
          principalSession,
          projectSession,
        ]);

        // Replace an existing session binding in place.
        yield* sessionPrincipals.put({
          sessionId: projectSession,
          principalId: member,
          bindingKind: "principal",
        });
        assert.deepStrictEqual(Option.getOrThrow(yield* sessionPrincipals.get(projectSession)), {
          principalId: member,
          bindingKind: "principal",
          binding: undefined,
        });

        assert.isTrue(yield* sessionPrincipals.remove(envSession));
        assert.isFalse(yield* sessionPrincipals.remove(envSession));
        assert.isTrue(Option.isNone(yield* sessionPrincipals.get(envSession)));

        assert.strictEqual(yield* sessionPrincipals.removeAllForPrincipal(member), 2);
        assert.deepStrictEqual(yield* sessionPrincipals.listForPrincipal(member), []);
      }),
    );
  },
);

it.layer(NodeServices.layer)("environment access revision persistence", (it) => {
  it.effect("monotonically advances on principal mutations and survives restarts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-access-revision-" });
      const dbPath = path.join(dir, "statev2.sqlite");
      const openLayer = () => Principals.layer.pipe(Layer.provide(Sqlite.layerFromPath(dbPath)));

      const persistedAfterFirstBoot = yield* Effect.gen(function* () {
        const principals = yield* Principals.PrincipalRepository;
        const initial = yield* principals.getEnvironmentAccessRevision;
        assert.strictEqual(initial, 0);

        const nextTwo = yield* principals.streamEnvironmentAccessRevision.pipe(
          Stream.take(3),
          Stream.runCollect,
          Effect.forkScoped,
        );
        // Yield once so the PubSub subscription is active before mutations run.
        yield* Effect.yieldNow;

        yield* principals.create({
          id: member,
          kind: "member",
          displayName: "Ada",
          email: null,
          status: "active",
          ceiling: ["orchestration:read"],
          createdAt: at("2026-11-25T00:00:00.000Z"),
        });
        const afterCreate = yield* principals.getEnvironmentAccessRevision;
        assert.isTrue(afterCreate > initial);

        yield* principals.update({
          id: member,
          ceiling: ["orchestration:read", "filesystem:read"],
          updatedAt: at("2026-11-25T00:01:00.000Z"),
          bumpAccessRevision: true,
        });
        const afterUpdate = yield* principals.getEnvironmentAccessRevision;
        assert.isTrue(afterUpdate > afterCreate);

        yield* principals.bumpAccessRevision(member, at("2026-11-25T00:02:00.000Z"));
        const afterBump = yield* principals.getEnvironmentAccessRevision;
        assert.isTrue(afterBump > afterUpdate);

        const streamed = Array.from(yield* Fiber.join(nextTwo));
        assert.deepStrictEqual(streamed, [afterCreate, afterUpdate, afterBump]);
        return afterBump;
      }).pipe(Effect.scoped, Effect.provide(openLayer()));

      // Reopen a fresh SQLite + PrincipalRepository layer to simulate a server restart.
      yield* Effect.gen(function* () {
        const principals = yield* Principals.PrincipalRepository;
        const afterRestart = yield* principals.getEnvironmentAccessRevision;
        assert.strictEqual(afterRestart, persistedAfterFirstBoot);

        yield* principals.bumpAccessRevision(member, at("2026-11-25T00:03:00.000Z"));
        const afterNextMutation = yield* principals.getEnvironmentAccessRevision;
        assert.strictEqual(afterNextMutation, persistedAfterFirstBoot + 1);
      }).pipe(Effect.scoped, Effect.provide(openLayer()));
    }),
  );
});
