import { assert, describe, it } from "@effect/vitest";
import { type AppendAuditEventInput, PrincipalId, ProjectId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as AuditEvents from "./AuditEvents.ts";
import { runMigrations } from "./Migrations.ts";
import * as Sqlite from "./Sqlite.ts";

const OWNER_ID = PrincipalId.make("owner");
const PROJECT_A = ProjectId.make("project-audit-chain-a");

const makeEvent = (overrides: Partial<AppendAuditEventInput> = {}): AppendAuditEventInput => ({
  at: "2026-11-26T12:00:00.000Z",
  actorPrincipalId: OWNER_ID,
  actorSessionId: null,
  action: "login.succeeded",
  resourceType: "session",
  resourceId: "sess-1",
  projectId: PROJECT_A,
  ip: "127.0.0.1",
  userAgent: "test-agent",
  outcome: "allow",
  metadata: { b: 2, a: 1 },
  ...overrides,
});

const layerTest = AuditEvents.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

describe("AuditEvents hash chain", () => {
  it.effect("verifies an empty and intact multi-event chain", () =>
    Effect.gen(function* () {
      const repo = yield* AuditEvents.AuditEventRepository;

      assert.deepStrictEqual(yield* repo.verifyChain, {
        valid: true,
        checked: 0,
        firstBrokenId: null,
        reason: null,
      });

      yield* repo.append(makeEvent({ at: "2026-11-26T12:00:01.000Z", action: "login.succeeded" }));
      yield* repo.append(makeEvent({ at: "2026-11-26T12:00:02.000Z", action: "token.created" }));
      yield* repo.append(makeEvent({ at: "2026-11-26T12:00:03.000Z", action: "crm.exported" }));

      assert.deepStrictEqual(yield* repo.verifyChain, {
        valid: true,
        checked: 3,
        firstBrokenId: null,
        reason: null,
      });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("reports the first broken id when a middle row payload is tampered with", () =>
    Effect.gen(function* () {
      const repo = yield* AuditEvents.AuditEventRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* repo.append(makeEvent({ at: "2026-11-26T12:00:01.000Z", action: "login.succeeded" }));
      const secondId = yield* repo.append(
        makeEvent({ at: "2026-11-26T12:00:02.000Z", action: "token.created" }),
      );
      yield* repo.append(makeEvent({ at: "2026-11-26T12:00:03.000Z", action: "logout" }));

      yield* sql`UPDATE audit_events SET outcome = 'deny' WHERE id = ${secondId}`;

      assert.deepStrictEqual(yield* repo.verifyChain, {
        valid: false,
        checked: 1,
        firstBrokenId: secondId,
        reason: "hash_mismatch",
      });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("reports the broken id when the last row is tampered with", () =>
    Effect.gen(function* () {
      const repo = yield* AuditEvents.AuditEventRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* repo.append(makeEvent({ at: "2026-11-26T12:00:01.000Z" }));
      const lastId = yield* repo.append(makeEvent({ at: "2026-11-26T12:00:02.000Z" }));

      yield* sql`UPDATE audit_events SET metadata_json = '{"tampered":true}' WHERE id = ${lastId}`;

      assert.deepStrictEqual(yield* repo.verifyChain, {
        valid: false,
        checked: 1,
        firstBrokenId: lastId,
        reason: "hash_mismatch",
      });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("reports prev_hash_mismatch when a middle row is deleted", () =>
    Effect.gen(function* () {
      const repo = yield* AuditEvents.AuditEventRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* repo.append(makeEvent({ at: "2026-11-26T12:00:01.000Z" }));
      const secondId = yield* repo.append(makeEvent({ at: "2026-11-26T12:00:02.000Z" }));
      const thirdId = yield* repo.append(makeEvent({ at: "2026-11-26T12:00:03.000Z" }));

      yield* sql`DELETE FROM audit_events WHERE id = ${secondId}`;

      assert.deepStrictEqual(yield* repo.verifyChain, {
        valid: false,
        checked: 1,
        firstBrokenId: thirdId,
        reason: "prev_hash_mismatch",
      });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "keeps remaining rows verifiable after retention pruning removes the oldest prefix",
    () =>
      Effect.gen(function* () {
        const repo = yield* AuditEvents.AuditEventRepository;

        yield* repo.append(makeEvent({ at: "2026-11-01T00:00:00.000Z" }));
        yield* repo.append(makeEvent({ at: "2026-11-20T00:00:00.000Z" }));
        yield* repo.append(makeEvent({ at: "2026-11-25T00:00:00.000Z" }));

        const pruned = yield* repo.pruneBefore("2026-11-10T00:00:00.000Z");
        assert.strictEqual(pruned, 1);

        assert.deepStrictEqual(yield* repo.verifyChain, {
          valid: true,
          checked: 2,
          firstBrokenId: null,
          reason: null,
        });
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("migration 119 backfills legacy unhashed audit_events rows into a valid chain", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 118 });

      yield* sql`
        INSERT INTO audit_events (at, actor_principal_id, action, outcome, metadata_json)
        VALUES
          (1700000001000, 'owner', 'login.succeeded', 'allow', '{"k":"v1"}'),
          (1700000002000, 'owner', 'logout', 'allow', NULL)
      `;

      yield* runMigrations();

      const repo = yield* AuditEvents.AuditEventRepository;
      assert.deepStrictEqual(yield* repo.verifyChain, {
        valid: true,
        checked: 2,
        firstBrokenId: null,
        reason: null,
      });

      yield* repo.append(makeEvent({ at: "2026-11-26T12:00:05.000Z" }));
      assert.deepStrictEqual(yield* repo.verifyChain, {
        valid: true,
        checked: 3,
        firstBrokenId: null,
        reason: null,
      });
    }).pipe(
      Effect.provide(
        AuditEvents.layer.pipe(
          Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
        ),
      ),
    ),
  );
});
