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

/** Every field narrows the list; omitted ones do not filter. */
export const ListAuditEventsInput = Schema.Struct({
  projectId: Schema.optionalKey(ProjectId),
  actorPrincipalId: Schema.optionalKey(PrincipalId),
  action: Schema.optionalKey(AuditAction),
  from: Schema.optionalKey(IsoDateTime),
  to: Schema.optionalKey(IsoDateTime),
  limit: Schema.optionalKey(NonNegativeInt),
});
export type ListAuditEventsInput = typeof ListAuditEventsInput.Type;
