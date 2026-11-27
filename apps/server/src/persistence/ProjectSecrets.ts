import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { ProjectId, ProjectSecret, TrimmedNonEmptyString } from "@t3tools/contracts";

import { EpochMillis } from "./epochMillis.ts";
import {
  type ProjectSecretRepositoryError,
  PersistenceDecodeError,
  PersistenceSqlError,
} from "./Errors.ts";

const ProjectSecretMetadataRow = Schema.Struct({
  projectId: ProjectId,
  name: TrimmedNonEmptyString,
  fingerprint: TrimmedNonEmptyString,
  updatedAt: EpochMillis,
});

const ProjectSecretEncryptedRow = Schema.Struct({
  projectId: ProjectId,
  name: TrimmedNonEmptyString,
  ciphertext: Schema.Uint8Array,
  fingerprint: TrimmedNonEmptyString,
  updatedAt: EpochMillis,
});
export type EncryptedProjectSecretRecord = typeof ProjectSecretEncryptedRow.Type;

const ProjectSecretKey = Schema.Struct({
  projectId: ProjectId,
  name: TrimmedNonEmptyString,
});

const UpsertProjectSecretRow = Schema.Struct({
  projectId: ProjectId,
  name: TrimmedNonEmptyString,
  ciphertext: Schema.Uint8Array,
  fingerprint: TrimmedNonEmptyString,
  updatedAt: EpochMillis,
});
export type UpsertProjectSecretInput = typeof UpsertProjectSecretRow.Type;

function toSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProjectSecretRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause)
      : new PersistenceSqlError({ operation: sqlOperation, cause });
}

export class ProjectSecretRepository extends Context.Service<
  ProjectSecretRepository,
  {
    readonly listForProject: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<ProjectSecret>, ProjectSecretRepositoryError>;
    readonly get: (
      projectId: ProjectId,
      name: string,
    ) => Effect.Effect<Option.Option<EncryptedProjectSecretRecord>, ProjectSecretRepositoryError>;
    readonly upsert: (
      input: UpsertProjectSecretInput,
    ) => Effect.Effect<void, ProjectSecretRepositoryError>;
    readonly remove: (
      projectId: ProjectId,
      name: string,
    ) => Effect.Effect<boolean, ProjectSecretRepositoryError>;
  }
>()("v3code/persistence/ProjectSecrets/ProjectSecretRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listRows = SqlSchema.findAll({
    Request: ProjectId,
    Result: ProjectSecretMetadataRow,
    execute: (projectId) => sql`
      SELECT
        project_id AS "projectId",
        name AS "name",
        fingerprint AS "fingerprint",
        updated_at AS "updatedAt"
      FROM project_secrets
      WHERE project_id = ${projectId}
      ORDER BY name ASC
    `,
  });

  const getRow = SqlSchema.findOneOption({
    Request: ProjectSecretKey,
    Result: ProjectSecretEncryptedRow,
    execute: ({ projectId, name }) => sql`
      SELECT
        project_id AS "projectId",
        name AS "name",
        ciphertext AS "ciphertext",
        fingerprint AS "fingerprint",
        updated_at AS "updatedAt"
      FROM project_secrets
      WHERE project_id = ${projectId} AND name = ${name}
      LIMIT 1
    `,
  });

  const upsertRow = SqlSchema.void({
    Request: UpsertProjectSecretRow,
    execute: (input) => sql`
      INSERT INTO project_secrets (project_id, name, ciphertext, fingerprint, updated_at)
      VALUES (${input.projectId}, ${input.name}, ${input.ciphertext}, ${input.fingerprint}, ${input.updatedAt})
      ON CONFLICT (project_id, name)
      DO UPDATE SET
        ciphertext = excluded.ciphertext,
        fingerprint = excluded.fingerprint,
        updated_at = excluded.updated_at
    `,
  });

  const removeRow = SqlSchema.findAll({
    Request: ProjectSecretKey,
    Result: Schema.Struct({ name: TrimmedNonEmptyString }),
    execute: ({ projectId, name }) => sql`
      DELETE FROM project_secrets
      WHERE project_id = ${projectId} AND name = ${name}
      RETURNING name AS "name"
    `,
  });

  return ProjectSecretRepository.of({
    listForProject: Effect.fn("ProjectSecretRepository.listForProject")((projectId) =>
      listRows(projectId).pipe(
        Effect.mapError(toSqlOrDecodeError("listProjectSecrets", "ProjectSecret")),
      ),
    ),
    get: Effect.fn("ProjectSecretRepository.get")((projectId, name) =>
      getRow({ projectId, name: TrimmedNonEmptyString.make(name) }).pipe(
        Effect.mapError(toSqlOrDecodeError("getProjectSecret", "EncryptedProjectSecretRecord")),
      ),
    ),
    upsert: Effect.fn("ProjectSecretRepository.upsert")((input) =>
      upsertRow(input).pipe(
        Effect.mapError(toSqlOrDecodeError("upsertProjectSecret", "UpsertProjectSecretInput")),
      ),
    ),
    remove: Effect.fn("ProjectSecretRepository.remove")((projectId, name) =>
      removeRow({ projectId, name: TrimmedNonEmptyString.make(name) }).pipe(
        Effect.mapError(toSqlOrDecodeError("removeProjectSecret", "ProjectSecretKey")),
        Effect.map((rows) => rows.length > 0),
      ),
    ),
  } satisfies ProjectSecretRepository["Service"]);
});

export const layer = Layer.effect(ProjectSecretRepository, make);
