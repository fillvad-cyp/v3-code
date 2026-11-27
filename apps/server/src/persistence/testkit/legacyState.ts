import {
  AuthEnvironmentScopes,
  AuthOrchestrationReadScope,
  AuthSessionId,
  AuthStandardClientScopes,
  OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as PayloadSigner from "../../auth/PayloadSigner.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { base64UrlEncode } from "../../auth/utils.ts";
import { runMigrations } from "../Migrations.ts";

const LEGACY_MULTIUSER_PRE_MIGRATION_ID = 111;

const SIGNING_SECRET_NAME = "server-signing-key";
const encodeAppThreadJson = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2AppThread));
const encodeScopesJson = Schema.encodeSync(Schema.fromJsonString(AuthEnvironmentScopes));
const LegacySessionClaims = Schema.Struct({
  v: Schema.Literal(2),
  kind: Schema.Literal("session"),
  sid: AuthSessionId,
  sub: Schema.String,
  scopes: AuthEnvironmentScopes,
  method: Schema.Literal("browser-session-cookie"),
  iat: Schema.Number,
  exp: Schema.Number,
});
const encodeSessionClaimsJson = Schema.encodeSync(Schema.fromJsonString(LegacySessionClaims));

export interface LegacyStateSeedOptions {
  readonly projectId?: ProjectId;
  readonly projectTitle?: string;
  readonly workspaceRoot?: string;
  readonly threadId?: ThreadId;
  readonly threadTitle?: string;
  readonly sessionId?: AuthSessionId;
  readonly extraLiveSessionIds?: ReadonlyArray<AuthSessionId>;
  readonly revokedSessionId?: AuthSessionId;
  readonly subject?: string;
  readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
}

export interface LegacyStateFixture {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly sessionId: AuthSessionId;
  readonly liveSessionIds: ReadonlyArray<AuthSessionId>;
  readonly revokedSessionId: AuthSessionId;
  readonly subject: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly cookieToken: string;
}

/**
 * Builds a pre-multi-user SQLite database (migrations 1..111 only) seeded with a project, a
 * thread, live auth sessions, a revoked session, and a signed browser-session cookie token whose
 * wire format matches `SessionStore`.
 */
export const seedLegacyState = Effect.fn("testkit.seedLegacyState")(function* (
  options: LegacyStateSeedOptions = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;

  yield* runMigrations({ toMigrationInclusive: LEGACY_MULTIUSER_PRE_MIGRATION_ID });

  const now = yield* DateTime.now;
  const nowIso = DateTime.formatIso(now);
  const expiresAt = DateTime.addDuration(now, Duration.days(30));
  const expiresAtIso = DateTime.formatIso(expiresAt);

  const projectId = options.projectId ?? ProjectId.make("legacy-project");
  const projectTitle = options.projectTitle ?? "Legacy Project";
  const workspaceRoot = options.workspaceRoot ?? "/srv/legacy-project";
  const threadId = options.threadId ?? ThreadId.make("legacy-thread");
  const threadTitle = options.threadTitle ?? "Legacy Thread";
  const sessionId = options.sessionId ?? AuthSessionId.make("legacy-live-session");
  const extraLiveSessionIds = options.extraLiveSessionIds ?? [
    AuthSessionId.make("legacy-live-session-2"),
  ];
  const revokedSessionId = options.revokedSessionId ?? AuthSessionId.make("legacy-revoked-session");
  const subject = options.subject ?? "desktop-bootstrap";
  const scopes = options.scopes ?? [AuthOrchestrationReadScope, ...AuthStandardClientScopes];
  const uniqueScopes = [...new Set(scopes)];
  const scopesJson = encodeScopesJson(uniqueScopes);

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
      ${projectId},
      ${projectTitle},
      ${workspaceRoot},
      '[]',
      ${nowIso},
      ${nowIso}
    )
  `;

  const threadPayload = encodeAppThreadJson({
    id: threadId,
    projectId,
    title: threadTitle,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  });

  yield* sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id,
      project_id,
      title,
      default_provider,
      runtime_mode,
      interaction_mode,
      created_at,
      updated_at,
      payload_json
    )
    VALUES (
      ${threadId},
      ${projectId},
      ${threadTitle},
      'codex',
      'full-access',
      'default',
      ${nowIso},
      ${nowIso},
      ${threadPayload}
    )
  `;

  const liveSessionIds = [sessionId, ...extraLiveSessionIds];
  for (const liveId of liveSessionIds) {
    yield* sql`
      INSERT INTO auth_sessions (
        session_id,
        subject,
        scopes,
        method,
        issued_at,
        expires_at
      )
      VALUES (
        ${liveId},
        ${subject},
        ${scopesJson},
        'browser-session-cookie',
        ${nowIso},
        ${expiresAtIso}
      )
    `;
  }

  yield* sql`
    INSERT INTO auth_sessions (
      session_id,
      subject,
      scopes,
      method,
      issued_at,
      expires_at,
      revoked_at
    )
    VALUES (
      ${revokedSessionId},
      ${subject},
      ${scopesJson},
      'browser-session-cookie',
      ${nowIso},
      ${expiresAtIso},
      ${nowIso}
    )
  `;

  const signer = yield* PayloadSigner.fromSecret(
    yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32),
  );
  const encodedPayload = base64UrlEncode(
    encodeSessionClaimsJson({
      v: 2,
      kind: "session",
      sid: sessionId,
      sub: subject,
      scopes: uniqueScopes,
      method: "browser-session-cookie",
      iat: now.epochMilliseconds,
      exp: expiresAt.epochMilliseconds,
    }),
  );
  const cookieToken = `${encodedPayload}.${yield* signer.sign(encodedPayload)}`;

  return {
    projectId,
    threadId,
    sessionId,
    liveSessionIds,
    revokedSessionId,
    subject,
    scopes: uniqueScopes,
    cookieToken,
  } satisfies LegacyStateFixture;
});
