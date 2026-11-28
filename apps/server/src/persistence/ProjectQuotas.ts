import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { ProjectId, ProjectQuota } from "@t3tools/contracts";

import {
  type ProjectQuotaRepositoryError,
  PersistenceDecodeError,
  PersistenceSqlError,
} from "./Errors.ts";

const QuotaRow = Schema.Struct({
  projectId: ProjectId,
  maxActiveThreads: Schema.NullOr(Schema.Number),
  maxWorktrees: Schema.NullOr(Schema.Number),
  diskBytes: Schema.NullOr(Schema.Number),
  attachmentBytes: Schema.NullOr(Schema.Number),
});

export const SetProjectQuotaInput = Schema.Struct({
  projectId: ProjectId,
  maxActiveThreads: Schema.NullOr(Schema.Number),
  maxWorktrees: Schema.NullOr(Schema.Number),
  diskBytes: Schema.NullOr(Schema.Number),
  attachmentBytes: Schema.NullOr(Schema.Number),
});
export type SetProjectQuotaInput = typeof SetProjectQuotaInput.Type;

function toSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProjectQuotaRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause)
      : new PersistenceSqlError({ operation: sqlOperation, cause });
}

/** A null column is the built-in default; a missing row means every default. */
export class ProjectQuotaRepository extends Context.Service<
  ProjectQuotaRepository,
  {
    readonly get: (
      projectId: ProjectId,
    ) => Effect.Effect<ProjectQuota | undefined, ProjectQuotaRepositoryError>;
    readonly list: Effect.Effect<ReadonlyArray<ProjectQuota>, ProjectQuotaRepositoryError>;
    readonly set: (input: SetProjectQuotaInput) => Effect.Effect<void, ProjectQuotaRepositoryError>;
    readonly remove: (projectId: ProjectId) => Effect.Effect<boolean, ProjectQuotaRepositoryError>;
  }
>()("v3code/persistence/ProjectQuotas/ProjectQuotaRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const selectRow = sql`
    SELECT project_id AS "projectId", max_active_threads AS "maxActiveThreads",
      max_worktrees AS "maxWorktrees", disk_bytes AS "diskBytes",
      attachment_bytes AS "attachmentBytes"
    FROM project_quotas
  `;

  const getRow = SqlSchema.findOneOption({
    Request: ProjectId,
    Result: QuotaRow,
    execute: (projectId) => sql`${selectRow} WHERE project_id = ${projectId}`,
  });

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: QuotaRow,
    execute: () => sql`${selectRow} ORDER BY project_id`,
  });

  const setRow = SqlSchema.void({
    Request: SetProjectQuotaInput,
    execute: (input) =>
      sql`
        INSERT INTO project_quotas (project_id, max_active_threads, max_worktrees, disk_bytes,
          attachment_bytes)
        VALUES (${input.projectId}, ${input.maxActiveThreads}, ${input.maxWorktrees},
          ${input.diskBytes}, ${input.attachmentBytes})
        ON CONFLICT (project_id)
        DO UPDATE SET max_active_threads = excluded.max_active_threads,
          max_worktrees = excluded.max_worktrees, disk_bytes = excluded.disk_bytes,
          attachment_bytes = excluded.attachment_bytes
      `,
  });

  const removeRow = SqlSchema.findAll({
    Request: ProjectId,
    Result: Schema.Struct({ projectId: ProjectId }),
    execute: (projectId) =>
      sql`
        DELETE FROM project_quotas WHERE project_id = ${projectId}
        RETURNING project_id AS "projectId"
      `,
  });

  return ProjectQuotaRepository.of({
    get: Effect.fn("ProjectQuotaRepository.get")((projectId) =>
      getRow(projectId).pipe(
        Effect.mapError(toSqlOrDecodeError("getProjectQuota", "ProjectQuota")),
        Effect.map(Option.getOrUndefined),
      ),
    ),
    list: listRows(undefined).pipe(
      Effect.mapError(toSqlOrDecodeError("listProjectQuotas", "ProjectQuota")),
    ),
    set: Effect.fn("ProjectQuotaRepository.set")((input) =>
      setRow(input).pipe(
        Effect.mapError(toSqlOrDecodeError("setProjectQuota", "SetProjectQuotaInput")),
      ),
    ),
    remove: Effect.fn("ProjectQuotaRepository.remove")((projectId) =>
      removeRow(projectId).pipe(
        Effect.mapError(toSqlOrDecodeError("removeProjectQuota", "ProjectId")),
        Effect.map((rows) => rows.length > 0),
      ),
    ),
  } satisfies ProjectQuotaRepository["Service"]);
});

export const layer = Layer.effect(ProjectQuotaRepository, make);
