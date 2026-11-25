import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import {
  MembershipState,
  PrincipalId,
  ProjectId,
  ProjectMembership,
  ProjectRole,
} from "@t3tools/contracts";

import { EpochMillis, NullableEpochMillis } from "./epochMillis.ts";
import {
  type MembershipRepositoryError,
  PersistenceDecodeError,
  PersistenceSqlError,
} from "./Errors.ts";

const MembershipRow = Schema.Struct({
  projectId: ProjectId,
  principalId: PrincipalId,
  role: ProjectRole,
  state: MembershipState,
  invitedBy: Schema.NullOr(PrincipalId),
  expiresAt: NullableEpochMillis,
  createdAt: EpochMillis,
  updatedAt: EpochMillis,
});

const MembershipKey = Schema.Struct({
  projectId: ProjectId,
  principalId: PrincipalId,
});

export const UpsertMembershipInput = Schema.Struct({
  projectId: ProjectId,
  principalId: PrincipalId,
  role: ProjectRole,
  state: MembershipState,
  invitedBy: Schema.NullOr(PrincipalId),
  expiresAt: Schema.NullOr(EpochMillis),
  updatedAt: EpochMillis,
});
export type UpsertMembershipInput = typeof UpsertMembershipInput.Type;

export const SetMembershipRoleInput = Schema.Struct({
  projectId: ProjectId,
  principalId: PrincipalId,
  role: ProjectRole,
  updatedAt: EpochMillis,
});
export type SetMembershipRoleInput = typeof SetMembershipRoleInput.Type;

export const SetMembershipStateInput = Schema.Struct({
  projectId: ProjectId,
  principalId: PrincipalId,
  state: MembershipState,
  updatedAt: EpochMillis,
});
export type SetMembershipStateInput = typeof SetMembershipStateInput.Type;

export class MembershipRepository extends Context.Service<
  MembershipRepository,
  {
    readonly get: (
      projectId: ProjectId,
      principalId: PrincipalId,
    ) => Effect.Effect<Option.Option<ProjectMembership>, MembershipRepositoryError>;
    readonly listForProject: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<ProjectMembership>, MembershipRepositoryError>;
    readonly listForPrincipal: (
      principalId: PrincipalId,
    ) => Effect.Effect<ReadonlyArray<ProjectMembership>, MembershipRepositoryError>;
    /** Re-inviting an existing pair replaces its role and state rather than adding a row. */
    readonly upsert: (
      input: UpsertMembershipInput,
    ) => Effect.Effect<void, MembershipRepositoryError>;
    readonly setRole: (
      input: SetMembershipRoleInput,
    ) => Effect.Effect<boolean, MembershipRepositoryError>;
    readonly setState: (
      input: SetMembershipStateInput,
    ) => Effect.Effect<boolean, MembershipRepositoryError>;
    /** Hard delete, for a project being removed; ordinary removal keeps a `removed` row. */
    readonly delete: (
      projectId: ProjectId,
      principalId: PrincipalId,
    ) => Effect.Effect<boolean, MembershipRepositoryError>;
  }
>()("v3code/persistence/Memberships/MembershipRepository") {}

function toSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): MembershipRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause)
      : new PersistenceSqlError({ operation: sqlOperation, cause });
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const selectRow = sql`
    SELECT project_id AS "projectId", principal_id AS "principalId", role AS "role",
      state AS "state", invited_by AS "invitedBy", expires_at AS "expiresAt",
      created_at AS "createdAt", updated_at AS "updatedAt"
    FROM project_memberships
  `;

  const getRow = SqlSchema.findOneOption({
    Request: MembershipKey,
    Result: MembershipRow,
    execute: ({ projectId, principalId }) =>
      sql`${selectRow} WHERE project_id = ${projectId} AND principal_id = ${principalId}`,
  });

  const listRowsForProject = SqlSchema.findAll({
    Request: ProjectId,
    Result: MembershipRow,
    execute: (projectId) =>
      sql`${selectRow} WHERE project_id = ${projectId} ORDER BY created_at, principal_id`,
  });

  const listRowsForPrincipal = SqlSchema.findAll({
    Request: PrincipalId,
    Result: MembershipRow,
    execute: (principalId) =>
      sql`${selectRow} WHERE principal_id = ${principalId} ORDER BY created_at, project_id`,
  });

  const upsertRow = SqlSchema.void({
    Request: UpsertMembershipInput,
    execute: (input) =>
      sql`
        INSERT INTO project_memberships (project_id, principal_id, role, state, invited_by,
          expires_at, created_at, updated_at)
        VALUES (${input.projectId}, ${input.principalId}, ${input.role}, ${input.state},
          ${input.invitedBy}, ${input.expiresAt}, ${input.updatedAt}, ${input.updatedAt})
        ON CONFLICT (project_id, principal_id)
        DO UPDATE SET role = excluded.role, state = excluded.state,
          invited_by = excluded.invited_by, expires_at = excluded.expires_at,
          updated_at = excluded.updated_at
      `,
  });

  const setRoleRow = SqlSchema.findAll({
    Request: SetMembershipRoleInput,
    Result: MembershipKey,
    execute: ({ projectId, principalId, role, updatedAt }) =>
      sql`
        UPDATE project_memberships
        SET role = ${role}, updated_at = ${updatedAt}
        WHERE project_id = ${projectId} AND principal_id = ${principalId}
        RETURNING project_id AS "projectId", principal_id AS "principalId"
      `,
  });

  const setStateRow = SqlSchema.findAll({
    Request: SetMembershipStateInput,
    Result: MembershipKey,
    execute: ({ projectId, principalId, state, updatedAt }) =>
      sql`
        UPDATE project_memberships
        SET state = ${state}, updated_at = ${updatedAt}
        WHERE project_id = ${projectId} AND principal_id = ${principalId}
        RETURNING project_id AS "projectId", principal_id AS "principalId"
      `,
  });

  const deleteRow = SqlSchema.findAll({
    Request: MembershipKey,
    Result: MembershipKey,
    execute: ({ projectId, principalId }) =>
      sql`
        DELETE FROM project_memberships
        WHERE project_id = ${projectId} AND principal_id = ${principalId}
        RETURNING project_id AS "projectId", principal_id AS "principalId"
      `,
  });

  return MembershipRepository.of({
    get: Effect.fn("MembershipRepository.get")((projectId, principalId) =>
      getRow({ projectId, principalId }).pipe(
        Effect.mapError(toSqlOrDecodeError("getMembership", "ProjectMembership")),
      ),
    ),
    listForProject: Effect.fn("MembershipRepository.listForProject")((projectId) =>
      listRowsForProject(projectId).pipe(
        Effect.mapError(toSqlOrDecodeError("listProjectMemberships", "ProjectMembership")),
      ),
    ),
    listForPrincipal: Effect.fn("MembershipRepository.listForPrincipal")((principalId) =>
      listRowsForPrincipal(principalId).pipe(
        Effect.mapError(toSqlOrDecodeError("listPrincipalMemberships", "ProjectMembership")),
      ),
    ),
    upsert: Effect.fn("MembershipRepository.upsert")((input) =>
      upsertRow(input).pipe(
        Effect.mapError(toSqlOrDecodeError("upsertMembership", "UpsertMembershipInput")),
      ),
    ),
    setRole: Effect.fn("MembershipRepository.setRole")((input) =>
      setRoleRow(input).pipe(
        Effect.mapError(toSqlOrDecodeError("setMembershipRole", "SetMembershipRoleInput")),
        Effect.map((rows) => rows.length > 0),
      ),
    ),
    setState: Effect.fn("MembershipRepository.setState")((input) =>
      setStateRow(input).pipe(
        Effect.mapError(toSqlOrDecodeError("setMembershipState", "SetMembershipStateInput")),
        Effect.map((rows) => rows.length > 0),
      ),
    ),
    delete: Effect.fn("MembershipRepository.delete")((projectId, principalId) =>
      deleteRow({ projectId, principalId }).pipe(
        Effect.mapError(toSqlOrDecodeError("deleteMembership", "ProjectMembership")),
        Effect.map((rows) => rows.length > 0),
      ),
    ),
  } satisfies MembershipRepository["Service"]);
});

export const layer = Layer.effect(MembershipRepository, make);
