import * as Schema from "effect/Schema";

import {
  AuthSessionId,
  IsoDateTime,
  NonNegativeInt,
  PrincipalId,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/** Whether the audited attempt changed anything, was refused, or failed. */
export const AuditOutcome = Schema.Literals(["allow", "deny", "error"]);
export type AuditOutcome = typeof AuditOutcome.Type;

export const AuditAction = Schema.Literals([
  "login.succeeded",
  "login.failed",
  "logout",
  "invitation.created",
  "invitation.accepted",
  "invitation.revoked",
  "membership.role.changed",
  "membership.suspended",
  "membership.removed",
  "membership.expired",
  "member.suspended",
  "member.reactivated",
  "member.removed",
  "member.recovered",
  "owner.transferred",
  "session.issued",
  "session.revoked",
  "token.created",
  "token.revoked",
  "terminal.opened",
  "secret.read",
  "project.secret.set",
  "project.secret.deleted",
  "asset.url.issued",
  "preview.tunnel.opened",
  "authorization.denied",
  "quota.exceeded",
  "crm.exported",
  "crm.purged",
]);
export type AuditAction = typeof AuditAction.Type;

/** What an event was about; `resourceId` names the one row of it. */
export const AuditResourceType = Schema.Literals([
  "principal",
  "membership",
  "invitation",
  "session",
  "api_token",
  "project",
  "thread",
  "terminal",
  "secret",
  "asset",
  "preview",
  "crm_client",
  "crm_contact",
]);
export type AuditResourceType = typeof AuditResourceType.Type;

/**
 * One appended record. Actor and project are null where they are unknown or the event is
 * environment-wide. Metadata holds ids and fingerprints only, never secret values or message bodies.
 */
export const AuditEvent = Schema.Struct({
  id: NonNegativeInt,
  at: IsoDateTime,
  actorPrincipalId: Schema.NullOr(PrincipalId),
  actorSessionId: Schema.NullOr(AuthSessionId),
  action: AuditAction,
  resourceType: Schema.NullOr(AuditResourceType),
  resourceId: Schema.NullOr(TrimmedNonEmptyString),
  projectId: Schema.NullOr(ProjectId),
  ip: Schema.NullOr(Schema.String),
  userAgent: Schema.NullOr(Schema.String),
  outcome: AuditOutcome,
  metadata: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
});
export type AuditEvent = typeof AuditEvent.Type;

export const AppendAuditEventInput = Schema.Struct({
  at: IsoDateTime,
  actorPrincipalId: Schema.NullOr(PrincipalId),
  actorSessionId: Schema.NullOr(AuthSessionId),
  action: AuditAction,
  resourceType: Schema.NullOr(AuditResourceType),
  resourceId: Schema.NullOr(TrimmedNonEmptyString),
  projectId: Schema.NullOr(ProjectId),
  ip: Schema.NullOr(Schema.String),
  userAgent: Schema.NullOr(Schema.String),
  outcome: AuditOutcome,
  metadata: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
});
export type AppendAuditEventInput = typeof AppendAuditEventInput.Type;

export const AUDIT_LIST_DEFAULT_LIMIT = 50;
export const AUDIT_LIST_MAX_LIMIT = 200;

const AuditListLimit = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: AUDIT_LIST_MAX_LIMIT }),
);

const AuditCursorFromString = Schema.FiniteFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);

const AuditLimitFromString = Schema.FiniteFromString.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: AUDIT_LIST_MAX_LIMIT }),
);

/** Every field narrows the list; omitted ones do not filter. */
export const ListAuditEventsInput = Schema.Struct({
  projectId: Schema.optionalKey(ProjectId),
  actorPrincipalId: Schema.optionalKey(PrincipalId),
  action: Schema.optionalKey(AuditAction),
  from: Schema.optionalKey(IsoDateTime),
  to: Schema.optionalKey(IsoDateTime),
  /** Return events strictly older than this event id (`id < cursor`). */
  cursor: Schema.optionalKey(NonNegativeInt),
  limit: Schema.optionalKey(AuditListLimit),
});
export type ListAuditEventsInput = typeof ListAuditEventsInput.Type;

/** URL query form of `ListAuditEventsInput` where numeric parameters arrive as strings. */
export const ListAuditEventsQuery = Schema.Struct({
  projectId: ListAuditEventsInput.fields.projectId,
  actorPrincipalId: ListAuditEventsInput.fields.actorPrincipalId,
  action: ListAuditEventsInput.fields.action,
  from: ListAuditEventsInput.fields.from,
  to: ListAuditEventsInput.fields.to,
  cursor: Schema.optionalKey(AuditCursorFromString),
  limit: Schema.optionalKey(AuditLimitFromString),
});
export type ListAuditEventsQuery = typeof ListAuditEventsQuery.Type;

export const ListAuditEventsResult = Schema.Struct({
  events: Schema.Array(AuditEvent),
  nextCursor: Schema.NullOr(NonNegativeInt),
});
export type ListAuditEventsResult = typeof ListAuditEventsResult.Type;

const AuditChainBrokenReason = Schema.Literals([
  "missing_hash",
  "prev_hash_mismatch",
  "hash_mismatch",
]);

export const AuditChainVerificationResult = Schema.Struct({
  valid: Schema.Boolean,
  checked: NonNegativeInt,
  firstBrokenId: Schema.NullOr(NonNegativeInt),
  reason: Schema.NullOr(AuditChainBrokenReason),
});
export type AuditChainVerificationResult = typeof AuditChainVerificationResult.Type;
