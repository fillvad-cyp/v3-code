import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { IsoDateTime, NonNegativeInt, ProjectId } from "@t3tools/contracts";

import { EpochMillis } from "./epochMillis.ts";
import {
  PersistenceDecodeError,
  PersistenceSqlError,
  type ProjectUsageSampleRepositoryError,
} from "./Errors.ts";

const ProjectUsageSampleRow = Schema.Struct({
  projectId: ProjectId,
  diskBytes: NonNegativeInt,
  sampledAt: EpochMillis,
});

export interface ProjectUsageSample {
  readonly projectId: ProjectId;
  readonly diskBytes: number;
  readonly sampledAt: IsoDateTime;
}

export const UpsertProjectUsageSampleInput = Schema.Struct({
  projectId: ProjectId,
  diskBytes: NonNegativeInt,
  sampledAt: EpochMillis,
});
export type UpsertProjectUsageSampleInput = typeof UpsertProjectUsageSampleInput.Type;

function toSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProjectUsageSampleRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause)
      : new PersistenceSqlError({ operation: sqlOperation, cause });
}

export class ProjectUsageSampleRepository extends Context.Service<
  ProjectUsageSampleRepository,
  {
    readonly get: (
      projectId: ProjectId,
    ) => Effect.Effect<ProjectUsageSample | undefined, ProjectUsageSampleRepositoryError>;
    readonly list: Effect.Effect<
      ReadonlyArray<ProjectUsageSample>,
      ProjectUsageSampleRepositoryError
    >;
    readonly upsert: (
      input: UpsertProjectUsageSampleInput,
    ) => Effect.Effect<void, ProjectUsageSampleRepositoryError>;
  }
>()("v3code/persistence/ProjectUsageSamples/ProjectUsageSampleRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const selectRow = sql`
    SELECT project_id AS "projectId", disk_bytes AS "diskBytes", sampled_at AS "sampledAt"
    FROM project_usage_samples
  `;

  const getRow = SqlSchema.findOneOption({
    Request: ProjectId,
    Result: ProjectUsageSampleRow,
    execute: (projectId) => sql`${selectRow} WHERE project_id = ${projectId}`,
  });

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectUsageSampleRow,
    execute: () => sql`${selectRow} ORDER BY project_id`,
  });

  const upsertRow = SqlSchema.void({
    Request: UpsertProjectUsageSampleInput,
    execute: (input) =>
      sql`
        INSERT INTO project_usage_samples (project_id, disk_bytes, sampled_at)
        VALUES (${input.projectId}, ${input.diskBytes}, ${input.sampledAt})
        ON CONFLICT (project_id)
        DO UPDATE SET disk_bytes = excluded.disk_bytes, sampled_at = excluded.sampled_at
      `,
  });

  return ProjectUsageSampleRepository.of({
    get: Effect.fn("ProjectUsageSampleRepository.get")((projectId) =>
      getRow(projectId).pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError(toSqlOrDecodeError("getProjectUsageSample", "ProjectUsageSample")),
        Effect.map(Option.getOrUndefined),
      ),
    ),
    list: listRows(undefined).pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(toSqlOrDecodeError("listProjectUsageSamples", "ProjectUsageSample")),
    ),
    upsert: Effect.fn("ProjectUsageSampleRepository.upsert")((input) =>
      upsertRow(input).pipe(
        Effect.mapError(
          toSqlOrDecodeError("upsertProjectUsageSample", "UpsertProjectUsageSampleInput"),
        ),
      ),
    ),
  } satisfies ProjectUsageSampleRepository["Service"]);
});

export const layer = Layer.effect(ProjectUsageSampleRepository, make);
