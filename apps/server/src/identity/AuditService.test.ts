import { assert, it } from "@effect/vitest";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthSessionId,
  DEFAULT_AUDIT_RETENTION_DAYS,
  PrincipalId,
  ProjectId,
  type AppendAuditEventInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectAccess from "../access/ProjectAccess.ts";
import { assertServerSettingsUpdateAuthorized } from "../auth/RpcAuthorization.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as AuditEvents from "../persistence/AuditEvents.ts";
import * as Memberships from "../persistence/Memberships.ts";
import * as Principals from "../persistence/Principals.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AuditService from "./AuditService.ts";

const projectA = ProjectId.make("proj-a");
const projectB = ProjectId.make("proj-b");
const adminPrincipalId = PrincipalId.make("admin-1");
const devPrincipalId = PrincipalId.make("dev-1");
const ownerPrincipalId = PrincipalId.make("owner");

const makeEvent = (overrides: Partial<AppendAuditEventInput> = {}): AppendAuditEventInput => ({
  at: "2026-06-01T00:00:00.000Z",
  actorPrincipalId: ownerPrincipalId,
  actorSessionId: null,
  action: "login.succeeded",
  resourceType: "session",
  resourceId: "sess-1",
  projectId: null,
  ip: "127.0.0.1",
  userAgent: null,
  outcome: "allow",
  metadata: null,
  ...overrides,
});

const makeTestLayer = (settingsOverrides?: { readonly auditRetentionDays?: number }) => {
  const settingsLayer = ServerSettings.layerTest(settingsOverrides);
  const reposLayer = Layer.mergeAll(Principals.layer, Memberships.layer, AuditEvents.layer).pipe(
    Layer.provideMerge(Sqlite.layerMemory),
  );
  const accessLayer = ProjectAccess.layer.pipe(
    Layer.provide(reposLayer),
    Layer.provide(ProjectStore.layer.pipe(Layer.provide(Sqlite.layerMemory))),
  );
  const auditLayer = AuditService.layer.pipe(
    Layer.provide(reposLayer),
    Layer.provide(accessLayer),
    Layer.provide(settingsLayer),
  );
  return Layer.mergeAll(auditLayer, reposLayer, accessLayer, settingsLayer);
};

it.effect(
  "prunes audit events older than auditRetentionDays on an hourly schedule and logs count",
  () =>
    Effect.gen(function* () {
      const logged: Array<unknown> = [];
      const captureLogger = Logger.make(({ message }) => {
        logged.push(message);
      });

      const baseNow = DateTime.makeUnsafe("2026-06-01T00:00:00.000Z");
      yield* TestClock.setTime(DateTime.toEpochMillis(baseNow));

      const baseLayer = makeTestLayer();
      const retentionLayer = AuditService.layerRetention.pipe(Layer.provide(baseLayer));

      yield* Effect.gen(function* () {
        const repo = yield* AuditEvents.AuditEventRepository;
        const settings = yield* ServerSettings.ServerSettingsService;

        assert.strictEqual(
          (yield* settings.getSettings).auditRetentionDays,
          DEFAULT_AUDIT_RETENTION_DAYS,
        );

        // Older than 90 days (91 days old) -> pruned on first run.
        const idOld = yield* repo.append(
          makeEvent({
            at: DateTime.formatIso(DateTime.subtractDuration(baseNow, Duration.days(91))),
          }),
        );
        // 30 days old -> kept at 90d retention, pruned once retention is lowered to 14d.
        const idMedium = yield* repo.append(
          makeEvent({
            at: DateTime.formatIso(DateTime.subtractDuration(baseNow, Duration.days(30))),
          }),
        );
        // 1 day old -> always kept.
        const idRecent = yield* repo.append(
          makeEvent({
            at: DateTime.formatIso(DateTime.subtractDuration(baseNow, Duration.days(1))),
          }),
        );

        // Start the scheduled retention layer in a nested scope after seeding rows.
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Layer.build(retentionLayer);
            // Let the initial scheduled run execute at t=0.
            yield* TestClock.adjust(Duration.millis(1));

            const afterFirstRun = yield* repo.list({});
            assert.deepStrictEqual(
              afterFirstRun.map((row) => row.id),
              [idRecent, idMedium],
            );
            assert.isFalse(afterFirstRun.some((row) => row.id === idOld));

            // Lower retention to 14 days; next hourly tick should prune the 30-day-old event.
            yield* settings.updateSettings({ auditRetentionDays: 14 });
            yield* TestClock.adjust(Duration.hours(1));

            const afterSecondRun = yield* repo.list({});
            assert.deepStrictEqual(
              afterSecondRun.map((row) => row.id),
              [idRecent],
            );
          }),
        );
      }).pipe(Effect.provide(Layer.merge(baseLayer, Logger.layer([captureLogger]))));

      const pruneLogs = logged.filter((entry) =>
        Array.isArray(entry)
          ? entry.includes("Pruned expired audit events")
          : entry === "Pruned expired audit events",
      );
      assert.isTrue(pruneLogs.length >= 2);
      const prunedCounts = pruneLogs.map((entry) =>
        Array.isArray(entry)
          ? (
              entry.find(
                (item) => typeof item === "object" && item !== null && "pruned" in item,
              ) as { readonly pruned: number } | undefined
            )?.pruned
          : undefined,
      );
      assert.strictEqual(prunedCounts[0], 1);
      assert.strictEqual(prunedCounts[1], 1);
    }),
);

it.effect("restricts auditRetentionDays updates to owner only", () =>
  Effect.gen(function* () {
    const adminActor: ProjectAccess.AccessActor = {
      sessionId: AuthSessionId.make("sess-admin"),
      subject: "member",
      scopes: [AuthAccessReadScope, AuthAccessWriteScope],
      principalId: adminPrincipalId,
      binding: { _tag: "principal" },
      isOwner: false,
      roles: new Map([[projectA, "admin"]]),
    };
    const ownerActor: ProjectAccess.AccessActor = {
      sessionId: AuthSessionId.make("sess-owner"),
      subject: "owner",
      scopes: [AuthAccessReadScope, AuthAccessWriteScope],
      principalId: ownerPrincipalId,
      binding: { _tag: "environment" },
      isOwner: true,
      roles: new Map(),
    };

    const adminError = yield* assertServerSettingsUpdateAuthorized({
      actor: adminActor,
      patch: { auditRetentionDays: 30 },
      providerInstanceMutation: undefined,
      assertProject: ProjectAccess.assertActorCan,
    }).pipe(Effect.flip);
    assert.strictEqual(adminError._tag, "EnvironmentAuthorizationError");

    yield* assertServerSettingsUpdateAuthorized({
      actor: ownerActor,
      patch: { auditRetentionDays: 30 },
      providerInstanceMutation: undefined,
      assertProject: ProjectAccess.assertActorCan,
    });
  }),
);

it.effect(
  "scopes listForActor for projects-bound admins and rejects members without admin role",
  () =>
    Effect.gen(function* () {
      const layer = makeTestLayer();
      yield* Effect.gen(function* () {
        const repo = yield* AuditEvents.AuditEventRepository;
        const service = yield* AuditService.AuditService;

        const idA = yield* repo.append(makeEvent({ projectId: projectA }));
        yield* repo.append(makeEvent({ projectId: projectB }));
        yield* repo.append(makeEvent({ projectId: null }));

        const projectsAdminActor: ProjectAccess.AccessActor = {
          sessionId: AuthSessionId.make("sess-bound-admin"),
          subject: "token",
          scopes: [AuthAccessReadScope],
          principalId: adminPrincipalId,
          binding: { _tag: "projects", projects: [{ projectId: projectA, role: "admin" }] },
          isOwner: false,
          roles: new Map([[projectA, "admin"]]),
        };

        const res = yield* service.listForActor({ actor: projectsAdminActor, query: {} });
        assert.deepStrictEqual(
          res.events.map((event) => event.id),
          [idA],
        );

        const devActor: ProjectAccess.AccessActor = {
          sessionId: AuthSessionId.make("sess-dev"),
          subject: "member",
          scopes: [AuthAccessReadScope],
          principalId: devPrincipalId,
          binding: { _tag: "principal" },
          isOwner: false,
          roles: new Map([[projectA, "developer"]]),
        };
        const devErr = yield* service
          .listForActor({ actor: devActor, query: {} })
          .pipe(Effect.flip);
        assert.strictEqual(devErr._tag, "AuditForbiddenError");
        if (devErr._tag === "AuditForbiddenError") {
          assert.strictEqual(devErr.reason, "not_authorized");
        }

        // Lowered ceiling stripping access:read denies even a project admin.
        const strippedCeilingAdmin: ProjectAccess.AccessActor = {
          sessionId: AuthSessionId.make("sess-stripped"),
          subject: "member",
          scopes: [AuthAccessReadScope],
          principalId: adminPrincipalId,
          binding: { _tag: "principal" },
          isOwner: false,
          ceiling: [],
          roles: new Map([[projectA, "admin"]]),
        };
        const strippedErr = yield* service
          .listForActor({ actor: strippedCeilingAdmin, query: {} })
          .pipe(Effect.flip);
        assert.strictEqual(strippedErr._tag, "AuditForbiddenError");
      }).pipe(Effect.provide(layer));
    }),
);
