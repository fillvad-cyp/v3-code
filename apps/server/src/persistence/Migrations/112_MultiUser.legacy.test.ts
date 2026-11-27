import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  AuthOrchestrationReadScope,
  ORCHESTRATION_V2_WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectAccess from "../../access/ProjectAccess.ts";
import * as ResourceResolver from "../../access/ResourceResolver.ts";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as RpcAuthorization from "../../auth/RpcAuthorization.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";
import * as Memberships from "../Memberships.ts";
import { runMigrations } from "../Migrations.ts";
import * as Principals from "../Principals.ts";
import { seedLegacyState } from "../testkit/legacyState.ts";

interface TableColumnInfo {
  readonly name: string;
  readonly notnull: number;
  readonly dflt_value: string | null;
}

const listTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `;
  return rows.map((row) => row.name);
});

const tableInfo = (tableName: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.unsafe<TableColumnInfo>(`PRAGMA table_info("${tableName}")`);
  });

const readGroup = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (
      tag,
    ): tag is Exclude<
      keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES,
      typeof ORCHESTRATION_V2_WS_METHODS.getThreadProjection
    > => tag !== ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
  ),
);

const makeCookieRequest = (
  cookieName: string,
  cookieToken: string,
): Parameters<EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]>[0] =>
  ({
    cookies: { [cookieName]: cookieToken },
    headers: {},
  }) as unknown as Parameters<
    EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
  >[0];

describe("112_MultiUser legacy install upgrade", () => {
  it.effect(
    "upgrades a pre-112 database, binds live sessions to owner/environment, and passes orchestration read RPC with the old cookie",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const fixture = yield* seedLegacyState({
          scopes: [AuthOrchestrationReadScope],
        });

        const tablesBefore = yield* listTables;
        assert.notInclude(tablesBefore, "principals");
        assert.notInclude(tablesBefore, "session_principals");

        const columnsBefore = new Map<string, ReadonlySet<string>>();
        for (const table of tablesBefore) {
          const cols = yield* tableInfo(table);
          columnsBefore.set(table, new Set(cols.map((col) => col.name)));
        }

        // Upgrade from 111 to head (includes 112_MultiUser and 113_InvitationPrincipal).
        const applied = yield* runMigrations();
        assert.isTrue(applied.some(([id]) => id === 112));

        // 1. Owner principal exists with access_revision 0.
        const principals = yield* sql<{
          readonly id: string;
          readonly kind: string;
          readonly status: string;
          readonly accessRevision: number;
        }>`
          SELECT id, kind, status, access_revision AS "accessRevision"
          FROM principals
        `;
        assert.strictEqual(principals.length, 1);
        assert.deepStrictEqual(principals[0], {
          id: "owner",
          kind: "owner",
          status: "active",
          accessRevision: 0,
        });

        // 2. Every live session is bound to owner with binding_kind = environment; revoked stays unbound.
        const bindings = yield* sql<{
          readonly sessionId: string;
          readonly principalId: string;
          readonly bindingKind: string;
          readonly bindingJson: string | null;
        }>`
          SELECT
            session_id AS "sessionId",
            principal_id AS "principalId",
            binding_kind AS "bindingKind",
            binding_json AS "bindingJson"
          FROM session_principals
          ORDER BY session_id
        `;
        assert.deepStrictEqual(
          bindings,
          [...fixture.liveSessionIds].toSorted().map((sessionId) => ({
            sessionId,
            principalId: "owner",
            bindingKind: "environment",
            bindingJson: null,
          })),
        );
        assert.notInclude(
          bindings.map((row) => row.sessionId),
          fixture.revokedSessionId,
        );

        // 3. Additive schema promise: every column added to pre-112 tables is nullable or has a default.
        const addedExistingColumns: Array<{
          readonly table: string;
          readonly column: TableColumnInfo;
        }> = [];
        for (const table of tablesBefore) {
          const beforeCols = columnsBefore.get(table) ?? new Set<string>();
          const afterCols = yield* tableInfo(table);
          for (const col of afterCols) {
            if (!beforeCols.has(col.name)) {
              addedExistingColumns.push({ table, column: col });
              assert.isTrue(
                col.notnull === 0 || col.dflt_value !== null,
                `Column ${table}.${col.name} must be nullable or have a default for rollback compatibility`,
              );
            }
          }
        }
        const projectColumnsAfter = yield* tableInfo("projection_projects");
        const ownerIdCol = projectColumnsAfter.find((col) => col.name === "owner_id");
        const visibilityCol = projectColumnsAfter.find((col) => col.name === "visibility");
        assert.isDefined(ownerIdCol);
        assert.strictEqual(ownerIdCol?.notnull, 0);
        assert.isDefined(visibilityCol);
        assert.strictEqual(visibilityCol?.dflt_value, "'shared'");
        assert.isAtLeast(addedExistingColumns.length, 2);

        // An older v1 write that omits owner_id and visibility still succeeds on the upgraded table.
        yield* sql`
          INSERT INTO projection_projects (
            project_id,
            title,
            workspace_root,
            scripts_json,
            created_at,
            updated_at
          )
          VALUES (
            'v1-rollback-project',
            'Rollback Project',
            '/srv/v1-rollback-project',
            '[]',
            '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z'
          )
        `;
        const insertedV1 = yield* sql<{
          readonly ownerId: string | null;
          readonly visibility: string;
        }>`
          SELECT owner_id AS "ownerId", visibility
          FROM projection_projects
          WHERE project_id = 'v1-rollback-project'
        `;
        assert.deepStrictEqual(insertedV1, [{ ownerId: null, visibility: "shared" }]);

        // 4. Old cookie still authenticates and passes an orchestration read RPC unchanged.
        const postUpgradeLayer = (() => {
          const repos = Layer.mergeAll(
            Principals.layer,
            Memberships.layer,
            ProjectStore.layer,
            ProjectionStore.layer,
          );
          const access = ProjectAccess.layer.pipe(Layer.provide(repos));
          const resolver = ResourceResolver.layer.pipe(Layer.provide(repos));
          const auth = EnvironmentAuth.layer.pipe(
            Layer.provide(repos),
            Layer.provide(ManagedPolicy.layerTest()),
            Layer.provide(ServerEnvironment.layerIdentity),
          );
          return Layer.mergeAll(auth, access, resolver, repos);
        })();

        yield* Effect.gen(function* () {
          const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
          const sessionStore = yield* SessionStore.SessionStore;
          const access = yield* ProjectAccess.ProjectAccess;
          const resolver = yield* ResourceResolver.ResourceResolver;
          const projections = yield* ProjectionStore.ProjectionStoreV2;

          const request = makeCookieRequest(sessionStore.cookieName, fixture.cookieToken);
          const authenticated = yield* environmentAuth.authenticateHttpRequest(request);
          assert.strictEqual(authenticated.sessionId, fixture.sessionId);
          assert.strictEqual(authenticated.principalId, "owner");
          assert.deepStrictEqual(authenticated.binding, { _tag: "environment" });
          assert.deepStrictEqual(authenticated.scopes, [AuthOrchestrationReadScope]);

          const sessionState = yield* environmentAuth.getSessionState(request);
          assert.isTrue(sessionState.authenticated);
          if (sessionState.authenticated) {
            assert.strictEqual(sessionState.binding_kind, "environment");
            assert.strictEqual(sessionState.principal?.id, "owner");
            assert.strictEqual(sessionState.principal?.accessRevision, 0);
          }

          const actor = yield* access.resolve({
            sessionId: authenticated.sessionId,
            subject: authenticated.subject,
            scopes: authenticated.scopes,
            principalId: authenticated.principalId,
            binding: authenticated.binding,
          });
          assert.isTrue(actor.isOwner);
          assert.strictEqual(actor.accessRevision, 0);

          const gate = RpcAuthorization.makeAccessGate({ actor, access, resolver });
          const handlers = readGroup.toLayerHandler(
            ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
            ({ threadId }) => projections.getThreadProjection(threadId).pipe(Effect.orDie),
          );

          const client = yield* RpcTest.makeClient(readGroup).pipe(
            Effect.provide(
              Layer.merge(handlers, RpcAuthorization.layer(authenticated.scopes, undefined, gate)),
            ),
          );

          const projection = yield* client[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
            threadId: fixture.threadId,
          });
          assert.strictEqual(projection.thread.id, fixture.threadId);
          assert.strictEqual(projection.thread.projectId, fixture.projectId);
        }).pipe(Effect.provide(postUpgradeLayer), Effect.scoped);
      }).pipe(
        Effect.provide(
          (() => {
            const config = ServerConfig.layerTest(process.cwd(), {
              prefix: "t3-multiuser-legacy-test-",
            });
            const secrets = ServerSecretStore.layer.pipe(Layer.provide(config));
            return Layer.mergeAll(
              NodeSqliteClient.layer({ filename: ":memory:" }),
              config,
              secrets,
            ).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));
          })(),
        ),
        Effect.scoped,
      ),
  );
});
