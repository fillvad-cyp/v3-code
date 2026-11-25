import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import {
  Invitation,
  InvitationId,
  InvitationKind,
  PrincipalId,
  ProjectId,
  ProjectRole,
} from "@t3tools/contracts";

import { EpochMillis, NullableEpochMillis } from "./epochMillis.ts";
import {
  type InvitationRepositoryError,
  PersistenceDecodeError,
  PersistenceSqlError,
} from "./Errors.ts";

const InvitationRow = Schema.Struct({
  id: InvitationId,
  email: Schema.NullOr(Schema.String),
  kind: InvitationKind,
  role: ProjectRole,
  projectId: Schema.NullOr(ProjectId),
  ceiling: Schema.fromJsonString(Schema.Array(Schema.String)),
  createdBy: PrincipalId,
  createdAt: EpochMillis,
  expiresAt: EpochMillis,
  acceptedAt: NullableEpochMillis,
  revokedAt: NullableEpochMillis,
});

export const CreateInvitationInput = Schema.Struct({
  id: InvitationId,
  /** HMAC of the token; the raw token only ever leaves in the response. */
  tokenHash: Schema.String,
  email: Schema.NullOr(Schema.String),
  kind: InvitationKind,
  role: ProjectRole,
  projectId: Schema.NullOr(ProjectId),
  ceiling: Schema.Array(Schema.String),
  createdBy: PrincipalId,
  createdAt: EpochMillis,
  expiresAt: EpochMillis,
});
export type CreateInvitationInput = typeof CreateInvitationInput.Type;

export const ConsumeInvitationInput = Schema.Struct({
  tokenHash: Schema.String,
  now: EpochMillis,
});
export type ConsumeInvitationInput = typeof ConsumeInvitationInput.Type;

export const ListPendingInvitationsInput = Schema.Struct({
  now: EpochMillis,
  projectId: Schema.optionalKey(ProjectId),
  email: Schema.optionalKey(Schema.String),
});
export type ListPendingInvitationsInput = typeof ListPendingInvitationsInput.Type;

export const RevokeInvitationInput = Schema.Struct({
  id: InvitationId,
  revokedAt: EpochMillis,
});
export type RevokeInvitationInput = typeof RevokeInvitationInput.Type;

/**
 * Invitations keep the raw token out of the database and are spent by one atomic update, so two
 * acceptances cannot both win. A spent or revoked row stays for the audit trail.
 */
export class InvitationRepository extends Context.Service<
  InvitationRepository,
  {
    readonly create: (
      input: CreateInvitationInput,
    ) => Effect.Effect<void, InvitationRepositoryError>;
    readonly consume: (
      input: ConsumeInvitationInput,
    ) => Effect.Effect<Option.Option<Invitation>, InvitationRepositoryError>;
    readonly getByTokenHash: (
      tokenHash: string,
    ) => Effect.Effect<Option.Option<Invitation>, InvitationRepositoryError>;
    readonly listPending: (
      input: ListPendingInvitationsInput,
    ) => Effect.Effect<ReadonlyArray<Invitation>, InvitationRepositoryError>;
    readonly listForProject: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<Invitation>, InvitationRepositoryError>;
    readonly revoke: (
      input: RevokeInvitationInput,
    ) => Effect.Effect<boolean, InvitationRepositoryError>;
    readonly revokePendingForEmail: (
      email: string,
      revokedAt: EpochMillis,
    ) => Effect.Effect<number, InvitationRepositoryError>;
  }
>()("v3code/persistence/Invitations/InvitationRepository") {}

function toSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): InvitationRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause)
      : new PersistenceSqlError({ operation: sqlOperation, cause });
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const selectRow = sql`
    SELECT id AS "id", email AS "email", kind AS "kind", role AS "role",
      project_id AS "projectId", ceiling_json AS "ceiling", created_by AS "createdBy",
      created_at AS "createdAt", expires_at AS "expiresAt", accepted_at AS "acceptedAt",
      revoked_at AS "revokedAt"
    FROM invitations
  `;

  const pendingCondition = sql`
    accepted_at IS NULL AND revoked_at IS NULL
  `;

  const createRow = SqlSchema.void({
    Request: CreateInvitationInput,
    execute: (input) =>
      sql`
        INSERT INTO invitations (id, token_hash, email, kind, role, project_id, ceiling_json,
          created_by, created_at, expires_at)
        VALUES (${input.id}, ${input.tokenHash}, ${input.email}, ${input.kind}, ${input.role},
          ${input.projectId}, ${JSON.stringify(input.ceiling)}, ${input.createdBy},
          ${input.createdAt}, ${input.expiresAt})
      `,
  });

  const consumeRow = SqlSchema.findOneOption({
    Request: ConsumeInvitationInput,
    Result: InvitationRow,
    execute: ({ tokenHash, now }) =>
      sql`
        UPDATE invitations
        SET accepted_at = ${now}
        WHERE token_hash = ${tokenHash}
          AND ${pendingCondition}
          AND expires_at > ${now}
        RETURNING id AS "id", email AS "email", kind AS "kind", role AS "role",
          project_id AS "projectId", ceiling_json AS "ceiling", created_by AS "createdBy",
          created_at AS "createdAt", expires_at AS "expiresAt", accepted_at AS "acceptedAt",
          revoked_at AS "revokedAt"
      `,
  });

  const getRowByTokenHash = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: InvitationRow,
    execute: (tokenHash) => sql`${selectRow} WHERE token_hash = ${tokenHash}`,
  });

  const listPendingRows = SqlSchema.findAll({
    Request: ListPendingInvitationsInput,
    Result: InvitationRow,
    execute: ({ now, projectId, email }) =>
      sql`
        ${selectRow}
        WHERE ${pendingCondition}
          AND expires_at > ${now}
          AND (${projectId === undefined ? 1 : 0} = 1 OR project_id = ${projectId ?? null})
          AND (${email === undefined ? 1 : 0} = 1 OR email = ${email ?? null} COLLATE NOCASE)
        ORDER BY created_at DESC, id DESC
      `,
  });

  const listRowsForProject = SqlSchema.findAll({
    Request: ProjectId,
    Result: InvitationRow,
    execute: (projectId) =>
      sql`${selectRow} WHERE project_id = ${projectId} ORDER BY created_at DESC, id DESC`,
  });

  const revokeRow = SqlSchema.findAll({
    Request: RevokeInvitationInput,
    Result: Schema.Struct({ id: InvitationId }),
    execute: ({ id, revokedAt }) =>
      sql`
        UPDATE invitations
        SET revoked_at = ${revokedAt}
        WHERE id = ${id} AND ${pendingCondition}
        RETURNING id AS "id"
      `,
  });

  const revokePendingRowsForEmail = SqlSchema.findAll({
    Request: Schema.Struct({ email: Schema.String, revokedAt: EpochMillis }),
    Result: Schema.Struct({ id: InvitationId }),
    execute: ({ email, revokedAt }) =>
      sql`
        UPDATE invitations
        SET revoked_at = ${revokedAt}
        WHERE email = ${email} COLLATE NOCASE AND ${pendingCondition}
        RETURNING id AS "id"
      `,
  });

  return InvitationRepository.of({
    create: Effect.fn("InvitationRepository.create")((input) =>
      createRow(input).pipe(
        Effect.mapError(toSqlOrDecodeError("createInvitation", "CreateInvitationInput")),
      ),
    ),
    consume: Effect.fn("InvitationRepository.consume")((input) =>
      consumeRow(input).pipe(
        Effect.mapError(toSqlOrDecodeError("consumeInvitation", "Invitation")),
      ),
    ),
    getByTokenHash: Effect.fn("InvitationRepository.getByTokenHash")((tokenHash) =>
      getRowByTokenHash(tokenHash).pipe(
        Effect.mapError(toSqlOrDecodeError("getInvitationByToken", "Invitation")),
      ),
    ),
    listPending: Effect.fn("InvitationRepository.listPending")((input) =>
      listPendingRows(input).pipe(
        Effect.mapError(toSqlOrDecodeError("listPendingInvitations", "Invitation")),
      ),
    ),
    listForProject: Effect.fn("InvitationRepository.listForProject")((projectId) =>
      listRowsForProject(projectId).pipe(
        Effect.mapError(toSqlOrDecodeError("listProjectInvitations", "Invitation")),
      ),
    ),
    revoke: Effect.fn("InvitationRepository.revoke")((input) =>
      revokeRow(input).pipe(
        Effect.mapError(toSqlOrDecodeError("revokeInvitation", "RevokeInvitationInput")),
        Effect.map((rows) => rows.length > 0),
      ),
    ),
    revokePendingForEmail: Effect.fn("InvitationRepository.revokePendingForEmail")(
      (email, revokedAt) =>
        revokePendingRowsForEmail({ email, revokedAt }).pipe(
          Effect.mapError(toSqlOrDecodeError("revokePendingInvitations", "Invitation")),
          Effect.map((rows) => rows.length),
        ),
    ),
  } satisfies InvitationRepository["Service"]);
});

export const layer = Layer.effect(InvitationRepository, make);
