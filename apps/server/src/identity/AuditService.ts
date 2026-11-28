import {
  AUDIT_LIST_DEFAULT_LIMIT,
  AUDIT_LIST_MAX_LIMIT,
  type AuditChainVerificationResult,
  AuthAccessReadScope,
  type ListAuditEventsInput,
  type ListAuditEventsResult,
  ProjectId,
  passesProjectChecks,
  roleHasCapability,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import * as ProjectAccess from "../access/ProjectAccess.ts";
import * as AuditEvents from "../persistence/AuditEvents.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";

const AUDIT_RETENTION_INTERVAL = Duration.hours(1);
const DAY_MS = 86_400_000;

const AuditForbiddenReason = Schema.Literals(["not_authorized", "project_not_authorized"]);

export class AuditForbiddenError extends Schema.TaggedError<AuditForbiddenError>()(
  "AuditForbiddenError",
  {
    reason: AuditForbiddenReason,
    projectId: Schema.optionalKey(ProjectId),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not_authorized":
        return "Only the environment owner or a project admin may read audit events.";
      case "project_not_authorized":
        return "You do not have permission to read audit events for this project.";
    }
  }
}

export class AuditInvalidInputError extends Schema.TaggedError<AuditInvalidInputError>()(
  "AuditInvalidInputError",
  {
    field: Schema.Literals(["from", "to"]),
  },
) {
  override get message(): string {
    return `Invalid ISO timestamp for '${this.field}'.`;
  }
}

export class AuditInternalError extends Schema.TaggedError<AuditInternalError>()(
  "AuditInternalError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Audit operation failed (${this.operation}).`;
  }
}

interface ListAuditEventsForActorInput {
  readonly actor: ProjectAccess.AccessActor;
  readonly query: ListAuditEventsInput;
}

type ListAuditEventsError = AuditForbiddenError | AuditInvalidInputError | AuditInternalError;

export class AuditService extends Context.Service<
  AuditService,
  {
    readonly listForActor: (
      input: ListAuditEventsForActorInput,
    ) => Effect.Effect<ListAuditEventsResult, ListAuditEventsError>;
    readonly pruneExpired: Effect.Effect<number, AuditInternalError>;
    readonly verifyChain: Effect.Effect<AuditChainVerificationResult, AuditInternalError>;
  }
>()("v3code/identity/AuditService") {}

function adminProjectIdsForActor(actor: ProjectAccess.AccessActor): ReadonlyArray<ProjectId> {
  const ids: ProjectId[] = [];
  if (actor.binding?._tag === "projects") {
    for (const entry of actor.binding.projects) {
      if (roleHasCapability(entry.role, "project:members")) {
        ids.push(entry.projectId);
      }
    }
    return ids;
  }
  for (const [projectId, role] of actor.roles) {
    if (roleHasCapability(role, "project:members")) {
      ids.push(ProjectId.make(projectId));
    }
  }
  return ids;
}

const make = Effect.gen(function* () {
  const auditEvents = yield* AuditEvents.AuditEventRepository;
  const projectAccess = yield* ProjectAccess.ProjectAccess;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  const listForActor = Effect.fn("AuditService.listForActor")(function* (
    input: ListAuditEventsForActorInput,
  ) {
    const { actor, query } = input;
    if (query.from !== undefined && !Number.isFinite(Date.parse(query.from))) {
      return yield* new AuditInvalidInputError({ field: "from" });
    }
    if (query.to !== undefined && !Number.isFinite(Date.parse(query.to))) {
      return yield* new AuditInvalidInputError({ field: "to" });
    }

    const isOwner = actor.isOwner || passesProjectChecks(actor.binding);
    let scopedProjectIds: ReadonlyArray<ProjectId> | undefined;

    if (!isOwner) {
      if (!projectAccess.effectiveScopes(actor).includes(AuthAccessReadScope)) {
        return yield* new AuditForbiddenError({ reason: "not_authorized" });
      }
      const adminProjects = adminProjectIdsForActor(actor);
      if (adminProjects.length === 0) {
        return yield* new AuditForbiddenError({ reason: "not_authorized" });
      }
      if (query.projectId !== undefined) {
        if (!projectAccess.can(actor, query.projectId, "project:members")) {
          return yield* new AuditForbiddenError({
            reason: "project_not_authorized",
            projectId: query.projectId,
          });
        }
      } else {
        scopedProjectIds = adminProjects;
      }
    }

    const limit = Math.min(query.limit ?? AUDIT_LIST_DEFAULT_LIMIT, AUDIT_LIST_MAX_LIMIT);
    const rows = yield* auditEvents
      .list({
        ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
        ...(scopedProjectIds === undefined ? {} : { projectIds: scopedProjectIds }),
        ...(query.actorPrincipalId === undefined
          ? {}
          : { actorPrincipalId: query.actorPrincipalId }),
        ...(query.action === undefined ? {} : { action: query.action }),
        ...(query.from === undefined ? {} : { from: query.from }),
        ...(query.to === undefined ? {} : { to: query.to }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        limit: limit + 1,
      })
      .pipe(
        Effect.mapError((cause) => new AuditInternalError({ operation: "listForActor", cause })),
      );

    const hasMore = rows.length > limit;
    const events = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? (events[events.length - 1]?.id ?? null) : null;

    return { events, nextCursor } satisfies ListAuditEventsResult;
  });

  const pruneExpired = Effect.fn("AuditService.pruneExpired")(function* () {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError((cause) => new AuditInternalError({ operation: "pruneExpired", cause })),
    );
    const retentionDays = settings.auditRetentionDays;
    const nowMs = yield* Clock.currentTimeMillis;
    const cutoff = DateTime.formatIso(DateTime.makeUnsafe(nowMs - retentionDays * DAY_MS));
    const pruned = yield* auditEvents
      .pruneBefore(cutoff)
      .pipe(
        Effect.mapError((cause) => new AuditInternalError({ operation: "pruneExpired", cause })),
      );
    yield* Effect.annotateCurrentSpan({
      "audit.retention_days": retentionDays,
      "audit.pruned": pruned,
    });
    yield* Effect.logInfo("Pruned expired audit events", {
      pruned,
      retentionDays,
      cutoff,
    });
    return pruned;
  });

  const verifyChain = Effect.fn("AuditService.verifyChain")(function* () {
    return yield* auditEvents.verifyChain.pipe(
      Effect.mapError((cause) => new AuditInternalError({ operation: "verifyChain", cause })),
    );
  });

  return AuditService.of({
    listForActor,
    pruneExpired: pruneExpired(),
    verifyChain: verifyChain(),
  });
});

export const layer = Layer.effect(AuditService, make);

export const layerRetention = Layer.effectDiscard(
  Effect.gen(function* () {
    const audit = yield* AuditService;
    yield* forkParked(
      audit.pruneExpired.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Failed to prune expired audit events", { cause }),
        ),
        Effect.repeat(Schedule.spaced(AUDIT_RETENTION_INTERVAL)),
      ),
    );
  }),
);
