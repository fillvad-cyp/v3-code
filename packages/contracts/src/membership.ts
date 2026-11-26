import * as Schema from "effect/Schema";

import {
  ApiTokenId,
  AuthSessionId,
  InvitationId,
  IsoDateTime,
  NonNegativeInt,
  PrincipalId,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
/**
 * Who a principal is. `owner` stands outside project roles and passes every project check;
 * `external` is a CRM client, allowed only project resources.
 */
export const PrincipalKind = Schema.Literals(["owner", "member", "external", "service"]);
export type PrincipalKind = typeof PrincipalKind.Type;

export const PrincipalStatus = Schema.Literals(["invited", "active", "suspended", "removed"]);
export type PrincipalStatus = typeof PrincipalStatus.Type;

/**
 * A role. Ordered `viewer` ⊂ `operator` ⊂ `developer` ⊂ `admin`, with `manager` on a CRM branch.
 * `owner` holds the environment; it is never a project membership, only a ceiling-free principal.
 */
export const ProjectRole = Schema.Literals([
  "viewer",
  "operator",
  "developer",
  "manager",
  "admin",
  "owner",
]);
export type ProjectRole = typeof ProjectRole.Type;

export const MembershipState = Schema.Literals(["invited", "active", "suspended", "removed"]);
export type MembershipState = typeof MembershipState.Type;

export const InvitationKind = Schema.Literals(["staff", "client"]);
export type InvitationKind = typeof InvitationKind.Type;

/** Scope templates a principal ceiling is set from; the ceiling only narrows the project role. */
export const PrincipalCeilingTemplate = Schema.Literals(["staff", "restricted", "client"]);
export type PrincipalCeilingTemplate = typeof PrincipalCeilingTemplate.Type;

export const ProjectVisibility = Schema.Literals(["private", "shared"]);
export type ProjectVisibility = typeof ProjectVisibility.Type;

/**
 * How a session reaches projects: `environment` passes every project check (owner, service,
 * credentials from before projects existed), `principal` follows live memberships, `projects`
 * stays inside the listed projects and never widens to the principal.
 */
export const SessionBindingKind = Schema.Literals(["environment", "principal", "projects"]);
export type SessionBindingKind = typeof SessionBindingKind.Type;

/** One project a `projects` binding is held on, always with the role it was issued for. */
export const BoundProject = Schema.Struct({
  projectId: ProjectId,
  role: ProjectRole,
});
export type BoundProject = typeof BoundProject.Type;

export const SessionBinding = Schema.Union([
  Schema.TaggedStruct("environment", {}),
  Schema.TaggedStruct("principal", {}),
  Schema.TaggedStruct("projects", {
    projects: Schema.Array(BoundProject),
  }),
]);
export type SessionBinding = typeof SessionBinding.Type;

export const Principal = Schema.Struct({
  id: PrincipalId,
  kind: PrincipalKind,
  displayName: TrimmedNonEmptyString,
  email: Schema.NullOr(Schema.String),
  status: PrincipalStatus,
  ceiling: Schema.Array(Schema.String),
  accessRevision: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  removedAt: Schema.NullOr(IsoDateTime),
});
export type Principal = typeof Principal.Type;

export const ProjectMembership = Schema.Struct({
  projectId: ProjectId,
  principalId: PrincipalId,
  role: ProjectRole,
  state: MembershipState,
  invitedBy: Schema.NullOr(PrincipalId),
  expiresAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectMembership = typeof ProjectMembership.Type;

export const Invitation = Schema.Struct({
  id: InvitationId,
  email: Schema.NullOr(Schema.String),
  kind: InvitationKind,
  role: ProjectRole,
  /** Null is an invitation to the environment, which only an owner may issue. */
  projectId: Schema.NullOr(ProjectId),
  /** Non-null when this code logs an existing principal in instead of creating a new one. */
  principalId: Schema.optionalKey(Schema.NullOr(PrincipalId)),
  ceiling: Schema.Array(Schema.String),
  createdBy: PrincipalId,
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
  acceptedAt: Schema.NullOr(IsoDateTime),
  revokedAt: Schema.NullOr(IsoDateTime),
});
export type Invitation = typeof Invitation.Type;

export const ApiToken = Schema.Struct({
  id: ApiTokenId,
  principalId: PrincipalId,
  scopes: Schema.Array(Schema.String),
  binding: SessionBinding,
  expiresAt: Schema.NullOr(IsoDateTime),
  lastUsedAt: Schema.NullOr(IsoDateTime),
  revokedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
});
export type ApiToken = typeof ApiToken.Type;

export const ProjectSecret = Schema.Struct({
  projectId: ProjectId,
  name: TrimmedNonEmptyString,
  fingerprint: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
});
export type ProjectSecret = typeof ProjectSecret.Type;

export const DEFAULT_MEMBER_MAX_SESSIONS = 5;
export const DEFAULT_MEMBER_MAX_TERMINALS = 3;
export const DEFAULT_MEMBER_MAX_PREVIEW_TABS = 4;
export const DEFAULT_MEMBER_INVITES_PER_HOUR = 10;
export const DEFAULT_MEMBER_MAX_API_TOKENS = 10;

export const DEFAULT_PROJECT_MAX_ACTIVE_THREADS = 10;
export const DEFAULT_PROJECT_MAX_WORKTREES = 5;
export const DEFAULT_PROJECT_DISK_BYTES = 5 * 1024 * 1024 * 1024;
export const DEFAULT_PROJECT_ATTACHMENT_BYTES = 200 * 1024 * 1024;
export const PROJECT_QUOTA_WARNING_RATIO = 0.8;

/** Null leaves the built-in default in place for that limit. */
export const MemberLimits = Schema.Struct({
  principalId: PrincipalId,
  maxSessions: Schema.NullOr(NonNegativeInt),
  maxTerminals: Schema.NullOr(NonNegativeInt),
  maxPreviewTabs: Schema.optionalKey(Schema.NullOr(NonNegativeInt)),
  invitesPerHour: Schema.NullOr(NonNegativeInt),
  maxApiTokens: Schema.NullOr(NonNegativeInt),
});
export type MemberLimits = typeof MemberLimits.Type;

/** Null leaves the built-in default in place for that quota. */
export const ProjectQuota = Schema.Struct({
  projectId: ProjectId,
  maxActiveThreads: Schema.NullOr(NonNegativeInt),
  maxWorktrees: Schema.NullOr(NonNegativeInt),
  diskBytes: Schema.NullOr(NonNegativeInt),
  attachmentBytes: Schema.NullOr(NonNegativeInt),
});
export type ProjectQuota = typeof ProjectQuota.Type;

export const ProjectQuotaLimits = Schema.Struct({
  maxActiveThreads: NonNegativeInt,
  maxWorktrees: NonNegativeInt,
  diskBytes: NonNegativeInt,
  attachmentBytes: NonNegativeInt,
});
export type ProjectQuotaLimits = typeof ProjectQuotaLimits.Type;

export const ProjectQuotaResource = Schema.Literals(["active_threads", "worktrees", "disk_bytes"]);
export type ProjectQuotaResource = typeof ProjectQuotaResource.Type;

export const ProjectQuotaWarning = Schema.Struct({
  resource: ProjectQuotaResource,
  level: Schema.Literals(["warning", "exceeded"]),
  current: NonNegativeInt,
  limit: NonNegativeInt,
  ratio: Schema.Number,
});
export type ProjectQuotaWarning = typeof ProjectQuotaWarning.Type;

export const ProjectUsageResult = Schema.Struct({
  projectId: ProjectId,
  activeThreads: NonNegativeInt,
  worktrees: NonNegativeInt,
  diskBytes: NonNegativeInt,
  sampledAt: Schema.NullOr(IsoDateTime),
  limits: ProjectQuotaLimits,
  warnings: Schema.Array(ProjectQuotaWarning),
});
export type ProjectUsageResult = typeof ProjectUsageResult.Type;

export class ProjectQuotaExceededError extends Schema.TaggedError<ProjectQuotaExceededError>()(
  "ProjectQuotaExceededError",
  {
    projectId: ProjectId,
    resource: ProjectQuotaResource,
    current: NonNegativeInt,
    limit: NonNegativeInt,
  },
) {
  override get message(): string {
    switch (this.resource) {
      case "active_threads":
        return `Project ${this.projectId} reached its active thread quota (${this.current}/${this.limit}). Archive or delete a thread before creating a new one.`;
      case "worktrees":
        return `Project ${this.projectId} reached its worktree quota (${this.current}/${this.limit}). Remove an unused worktree before creating a new one.`;
      case "disk_bytes":
        return `Project ${this.projectId} reached its disk quota (${this.current}/${this.limit} bytes). Free project space before creating new threads or worktrees.`;
    }
  }
}

/** The capability a role check names in `project_forbidden`, always `project:<capability>`. */
export const ProjectCapability = Schema.Literals([
  "project:read",
  "project:thread.operate",
  "project:terminal.read",
  "project:terminal.operate",
  "project:preview.operate",
  "project:file.write",
  "project:source.write",
  "project:thread.manage",
  "project:settings",
  "project:members",
  "project:secrets",
  "project:webhooks",
  "project:crm.read",
  "project:crm.write",
  "project:crm.invite_client",
  "project:create",
  "project:delete",
]);
export type ProjectCapability = typeof ProjectCapability.Type;

/** A resource of the session's project the role lacks a capability for. */
export class ProjectForbiddenError extends Schema.TaggedError<ProjectForbiddenError>()(
  "project_forbidden",
  {
    message: Schema.String,
    projectId: ProjectId,
    requiredPermission: ProjectCapability,
  },
) {}

/** A session that carries no project binding, which is every credential from before projects. */
export function passesProjectChecks(binding: SessionBinding | undefined): boolean {
  return binding === undefined || binding._tag === "environment";
}

/** The projects a binding can reach, or `undefined` for the environment-wide ones. */
export function boundProjectIds(
  binding: SessionBinding | undefined,
): ReadonlySet<string> | undefined {
  return binding?._tag === "projects"
    ? new Set(binding.projects.map((project) => project.projectId))
    : undefined;
}

/** The role a binding carries on one project, or `undefined` when it does not reach it. */
export function boundProjectRole(
  binding: SessionBinding | undefined,
  projectId: string,
): ProjectRole | undefined {
  return binding?._tag === "projects"
    ? binding.projects.find((project) => project.projectId === projectId)?.role
    : undefined;
}

/** The session row a principal-backed session is tracked by. */
export const SessionPrincipal = Schema.Struct({
  sessionId: AuthSessionId,
  principalId: PrincipalId,
  binding: SessionBinding,
});
export type SessionPrincipal = typeof SessionPrincipal.Type;

export const InvitationCreateInput = Schema.Struct({
  kind: Schema.optionalKey(Schema.Literal("staff")),
  role: ProjectRole,
  projectId: Schema.NullOr(ProjectId),
});
export type InvitationCreateInput = typeof InvitationCreateInput.Type;

export const InvitationCreateResult = Schema.Struct({
  invitation: Invitation,
  code: TrimmedNonEmptyString,
});
export type InvitationCreateResult = typeof InvitationCreateResult.Type;

export const InvitationAcceptInput = Schema.Struct({
  code: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
});
export type InvitationAcceptInput = typeof InvitationAcceptInput.Type;

export const InvitationLoginInput = Schema.Struct({
  code: TrimmedNonEmptyString,
});
export type InvitationLoginInput = typeof InvitationLoginInput.Type;

export const InvitationRevokeResult = Schema.Struct({
  revoked: Schema.Boolean,
});
export type InvitationRevokeResult = typeof InvitationRevokeResult.Type;

export const MemberWithMemberships = Schema.Struct({
  principal: Principal,
  memberships: Schema.Array(ProjectMembership),
});
export type MemberWithMemberships = typeof MemberWithMemberships.Type;

export const MemberUpdateInput = Schema.Struct({
  projectId: Schema.optionalKey(ProjectId),
  role: Schema.optionalKey(ProjectRole),
  state: Schema.optionalKey(Schema.Literals(["active", "suspended"])),
  ceiling: Schema.optionalKey(PrincipalCeilingTemplate),
});
export type MemberUpdateInput = typeof MemberUpdateInput.Type;

export const MemberRemoveResult = Schema.Struct({
  removed: Schema.Boolean,
  promotedOwner: Schema.optionalKey(Schema.Boolean),
});
export type MemberRemoveResult = typeof MemberRemoveResult.Type;

export const MemberLoginCodeResult = Schema.Struct({
  code: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
});
export type MemberLoginCodeResult = typeof MemberLoginCodeResult.Type;

export const PasswordSetInput = Schema.Struct({
  password: Schema.String,
});
export type PasswordSetInput = typeof PasswordSetInput.Type;

export const PasswordSetResult = Schema.Struct({
  updated: Schema.Literal(true),
});
export type PasswordSetResult = typeof PasswordSetResult.Type;

export const PasswordLoginInput = Schema.Union([
  Schema.Struct({
    email: TrimmedNonEmptyString,
    password: Schema.String,
  }),
  Schema.Struct({
    principalId: PrincipalId,
    password: Schema.String,
  }),
]);
export type PasswordLoginInput = typeof PasswordLoginInput.Type;

export const RecoveryIssueInput = Schema.Struct({
  principalId: Schema.optionalKey(PrincipalId),
});
export type RecoveryIssueInput = typeof RecoveryIssueInput.Type;

export const RecoveryIssueResult = Schema.Struct({
  code: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
  principalId: PrincipalId,
});
export type RecoveryIssueResult = typeof RecoveryIssueResult.Type;

export const RecoveryConfirmInput = Schema.Struct({
  code: TrimmedNonEmptyString,
  password: Schema.String,
});
export type RecoveryConfirmInput = typeof RecoveryConfirmInput.Type;

export const RecoveryConfirmResult = Schema.Struct({
  recovered: Schema.Literal(true),
  principalId: PrincipalId,
  revokedSessions: NonNegativeInt,
  revokedDevices: NonNegativeInt,
  revokedTokens: NonNegativeInt,
});
export type RecoveryConfirmResult = typeof RecoveryConfirmResult.Type;

export const OwnerTransferInput = Schema.Struct({
  toPrincipalId: PrincipalId,
  confirmation: TrimmedNonEmptyString,
});
export type OwnerTransferInput = typeof OwnerTransferInput.Type;

export const OwnerTransferResult = Schema.Struct({
  previousOwner: Principal,
  newOwner: Principal,
  adminProjectIds: Schema.Array(ProjectId),
});
export type OwnerTransferResult = typeof OwnerTransferResult.Type;

export const ApiTokenBindingInput = Schema.Union([
  Schema.TaggedStruct("principal", {}),
  Schema.TaggedStruct("projects", {
    projects: Schema.Array(BoundProject),
  }),
]);
export type ApiTokenBindingInput = typeof ApiTokenBindingInput.Type;

export const ApiTokenCreateInput = Schema.Struct({
  /** Owner may issue a token for another principal; omitted defaults to the caller. */
  principalId: Schema.optionalKey(PrincipalId),
  scopes: Schema.Array(Schema.String),
  binding: ApiTokenBindingInput,
  /** Optional ISO-8601 expiration timestamp; null or omitted means no expiration. */
  expiresAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
});
export type ApiTokenCreateInput = typeof ApiTokenCreateInput.Type;

export const ApiTokenCreateResult = Schema.Struct({
  apiToken: ApiToken,
  /** Raw bearer token with `t3p_` prefix; shown once on creation. */
  token: TrimmedNonEmptyString,
});
export type ApiTokenCreateResult = typeof ApiTokenCreateResult.Type;

export const ApiTokenListItem = Schema.Struct({
  ...ApiToken.fields,
  principalDisplayName: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ApiTokenListItem = typeof ApiTokenListItem.Type;

export const ApiTokenRevokeResult = Schema.Struct({
  revoked: Schema.Boolean,
});
export type ApiTokenRevokeResult = typeof ApiTokenRevokeResult.Type;
