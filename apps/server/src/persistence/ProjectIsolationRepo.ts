import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import {
  PositiveInt,
  ProjectId,
  ProjectIsolationAdoptionState,
  ProjectIsolationLevel,
  type ProjectIsolationRecord,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";

import { EpochMillis } from "./epochMillis.ts";
import {
  type ProjectIsolationRepositoryError,
  PersistenceDecodeError,
  PersistenceSqlError,
} from "./Errors.ts";

const ProjectIsolationDbRow = Schema.Struct({
  projectId: ProjectId,
  level: ProjectIsolationLevel,
  serviceUser: Schema.NullOr(TrimmedNonEmptyString),
  serviceGroup: Schema.NullOr(TrimmedNonEmptyString),
  portsFrom: Schema.NullOr(PositiveInt),
  portsTo: Schema.NullOr(PositiveInt),
  adoptionState: ProjectIsolationAdoptionState,
  fallbackReason: Schema.NullOr(Schema.String),
  adoptedAt: Schema.NullOr(EpochMillis),
  updatedAt: EpochMillis,
});

function toSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProjectIsolationRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause)
      : new PersistenceSqlError({ operation: sqlOperation, cause });
}

export class ProjectIsolationRepository extends Context.Service<
  ProjectIsolationRepository,
  {
    readonly get: (
      projectId: ProjectId,
    ) => Effect.Effect<Option.Option<ProjectIsolationRecord>, ProjectIsolationRepositoryError>;
    readonly list: () => Effect.Effect<
      ReadonlyArray<ProjectIsolationRecord>,
      ProjectIsolationRepositoryError
    >;
    readonly listActiveLevel1: () => Effect.Effect<
      ReadonlyArray<ProjectIsolationRecord>,
      ProjectIsolationRepositoryError
    >;
    readonly findByPort: (
      port: number,
    ) => Effect.Effect<Option.Option<ProjectIsolationRecord>, ProjectIsolationRepositoryError>;
    readonly upsert: (
      record: ProjectIsolationRecord,
    ) => Effect.Effect<void, ProjectIsolationRepositoryError>;
  }
>()("v3code/persistence/ProjectIsolationRepo/ProjectIsolationRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getRow = SqlSchema.findOneOption({
    Request: ProjectId,
    Result: ProjectIsolationDbRow,
    execute: (projectId) => sql`
      SELECT
        project_id AS "projectId",
        level AS "level",
        service_user AS "serviceUser",
        service_group AS "serviceGroup",
        ports_from AS "portsFrom",
        ports_to AS "portsTo",
        adoption_state AS "adoptionState",
        fallback_reason AS "fallbackReason",
        adopted_at AS "adoptedAt",
        updated_at AS "updatedAt"
      FROM project_isolation
      WHERE project_id = ${projectId}
      LIMIT 1
    `,
  });

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectIsolationDbRow,
    execute: () => sql`
      SELECT
        project_id AS "projectId",
        level AS "level",
        service_user AS "serviceUser",
        service_group AS "serviceGroup",
        ports_from AS "portsFrom",
        ports_to AS "portsTo",
        adoption_state AS "adoptionState",
        fallback_reason AS "fallbackReason",
        adopted_at AS "adoptedAt",
        updated_at AS "updatedAt"
      FROM project_isolation
      ORDER BY project_id ASC
    `,
  });

  const listActiveRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectIsolationDbRow,
    execute: () => sql`
      SELECT
        project_id AS "projectId",
        level AS "level",
        service_user AS "serviceUser",
        service_group AS "serviceGroup",
        ports_from AS "portsFrom",
        ports_to AS "portsTo",
        adoption_state AS "adoptionState",
        fallback_reason AS "fallbackReason",
        adopted_at AS "adoptedAt",
        updated_at AS "updatedAt"
      FROM project_isolation
      WHERE level = 1
      ORDER BY project_id ASC
    `,
  });

  const findByPortRow = SqlSchema.findOneOption({
    Request: PositiveInt,
    Result: ProjectIsolationDbRow,
    execute: (port) => sql`
      SELECT
        project_id AS "projectId",
        level AS "level",
        service_user AS "serviceUser",
        service_group AS "serviceGroup",
        ports_from AS "portsFrom",
        ports_to AS "portsTo",
        adoption_state AS "adoptionState",
        fallback_reason AS "fallbackReason",
        adopted_at AS "adoptedAt",
        updated_at AS "updatedAt"
      FROM project_isolation
      WHERE level = 1
        AND ports_from IS NOT NULL
        AND ports_to IS NOT NULL
        AND ${port} >= ports_from
        AND ${port} <= ports_to
      LIMIT 1
    `,
  });

  const upsertRow = SqlSchema.void({
    Request: ProjectIsolationDbRow,
    execute: (record) => sql`
      INSERT INTO project_isolation (
        project_id,
        level,
        service_user,
        service_group,
        ports_from,
        ports_to,
        adoption_state,
        fallback_reason,
        adopted_at,
        updated_at
      )
      VALUES (
        ${record.projectId},
        ${record.level},
        ${record.serviceUser},
        ${record.serviceGroup},
        ${record.portsFrom},
        ${record.portsTo},
        ${record.adoptionState},
        ${record.fallbackReason},
        ${record.adoptedAt},
        ${record.updatedAt}
      )
      ON CONFLICT (project_id)
      DO UPDATE SET
        level = excluded.level,
        service_user = excluded.service_user,
        service_group = excluded.service_group,
        ports_from = excluded.ports_from,
        ports_to = excluded.ports_to,
        adoption_state = excluded.adoption_state,
        fallback_reason = excluded.fallback_reason,
        adopted_at = excluded.adopted_at,
        updated_at = excluded.updated_at
    `,
  });

  return ProjectIsolationRepository.of({
    get: Effect.fn("ProjectIsolationRepository.get")((projectId) =>
      getRow(projectId).pipe(
        Effect.mapError(toSqlOrDecodeError("getProjectIsolation", "ProjectIsolationRecord")),
      ),
    ),
    list: Effect.fn("ProjectIsolationRepository.list")(() =>
      listRows(undefined).pipe(
        Effect.mapError(toSqlOrDecodeError("listProjectIsolation", "ProjectIsolationRecord")),
      ),
    ),
    listActiveLevel1: Effect.fn("ProjectIsolationRepository.listActiveLevel1")(() =>
      listActiveRows(undefined).pipe(
        Effect.mapError(
          toSqlOrDecodeError("listActiveLevel1ProjectIsolation", "ProjectIsolationRecord"),
        ),
      ),
    ),
    findByPort: Effect.fn("ProjectIsolationRepository.findByPort")((port) =>
      findByPortRow(PositiveInt.make(port)).pipe(
        Effect.mapError(toSqlOrDecodeError("findProjectIsolationByPort", "ProjectIsolationRecord")),
      ),
    ),
    upsert: Effect.fn("ProjectIsolationRepository.upsert")((record) =>
      upsertRow(record).pipe(
        Effect.mapError(toSqlOrDecodeError("upsertProjectIsolation", "ProjectIsolationRecord")),
      ),
    ),
  } satisfies ProjectIsolationRepository["Service"]);
});

export const layer = Layer.effect(ProjectIsolationRepository, make);
