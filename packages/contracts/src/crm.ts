import * as Schema from "effect/Schema";

import {
  CrmClientId,
  CrmContactId,
  CrmNoteId,
  IsoDateTime,
  PrincipalId,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { Invitation } from "./membership.ts";
import { OrchestrationV2ShellThreadStatus } from "./orchestrationV2.ts";

export const CrmClientStatus = Schema.Literals(["lead", "active", "inactive", "archived"]);
export type CrmClientStatus = typeof CrmClientStatus.Type;

export const CRM_REDACTED_PLACEHOLDER = "[redacted]";

/** Masks an email address so local-part PII is never exposed in UI, exports, or audit metadata. */
export function maskCrmEmail(email: string): string {
  const trimmed = email.trim();
  const atIndex = trimmed.indexOf("@");
  if (atIndex <= 0 || atIndex === trimmed.length - 1) {
    return "***";
  }
  const local = trimmed.slice(0, atIndex);
  const domain = trimmed.slice(atIndex + 1);
  if (local.length <= 1) {
    return `*@${domain}`;
  }
  return `${local[0]}***@${domain}`;
}

/** Masks a phone number while keeping at most the last 4 digits for recognition. */
export function maskCrmPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) {
    return "***";
  }
  return `***${digits.slice(-4)}`;
}

export const CrmClient = Schema.Struct({
  id: CrmClientId,
  projectId: ProjectId,
  principalId: Schema.NullOr(PrincipalId),
  name: Schema.String,
  company: Schema.NullOr(Schema.String),
  status: CrmClientStatus,
  emailMasked: Schema.NullOr(Schema.String),
  emailFingerprint: Schema.NullOr(Schema.String),
  phoneMasked: Schema.NullOr(Schema.String),
  phoneFingerprint: Schema.NullOr(Schema.String),
  redactedAt: Schema.NullOr(IsoDateTime),
  createdBy: Schema.NullOr(PrincipalId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CrmClient = typeof CrmClient.Type;

export const CrmContact = Schema.Struct({
  id: CrmContactId,
  projectId: ProjectId,
  clientId: CrmClientId,
  name: Schema.String,
  roleTitle: Schema.NullOr(Schema.String),
  emailMasked: Schema.NullOr(Schema.String),
  emailFingerprint: Schema.NullOr(Schema.String),
  phoneMasked: Schema.NullOr(Schema.String),
  phoneFingerprint: Schema.NullOr(Schema.String),
  redactedAt: Schema.NullOr(IsoDateTime),
  createdBy: Schema.NullOr(PrincipalId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CrmContact = typeof CrmContact.Type;

export const CrmNote = Schema.Struct({
  id: CrmNoteId,
  projectId: ProjectId,
  clientId: CrmClientId,
  contactId: Schema.NullOr(CrmContactId),
  body: Schema.String,
  redactedAt: Schema.NullOr(IsoDateTime),
  createdBy: Schema.NullOr(PrincipalId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CrmNote = typeof CrmNote.Type;

export const CrmClientThread = Schema.Struct({
  projectId: ProjectId,
  clientId: CrmClientId,
  threadId: ThreadId,
  redactedAt: Schema.NullOr(IsoDateTime),
  createdBy: Schema.NullOr(PrincipalId),
  createdAt: IsoDateTime,
});
export type CrmClientThread = typeof CrmClientThread.Type;

export const CrmClientDetail = Schema.Struct({
  client: CrmClient,
  contacts: Schema.Array(CrmContact),
  notes: Schema.Array(CrmNote),
  threads: Schema.Array(CrmClientThread),
});
export type CrmClientDetail = typeof CrmClientDetail.Type;

export const CrmClientCreateInput = Schema.Struct({
  name: TrimmedNonEmptyString,
  company: Schema.optionalKey(Schema.NullOr(Schema.String)),
  status: Schema.optionalKey(CrmClientStatus),
  email: Schema.optionalKey(Schema.NullOr(Schema.String)),
  phone: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type CrmClientCreateInput = typeof CrmClientCreateInput.Type;

export const CrmClientUpdateInput = Schema.Struct({
  name: Schema.optionalKey(TrimmedNonEmptyString),
  company: Schema.optionalKey(Schema.NullOr(Schema.String)),
  status: Schema.optionalKey(CrmClientStatus),
  email: Schema.optionalKey(Schema.NullOr(Schema.String)),
  phone: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type CrmClientUpdateInput = typeof CrmClientUpdateInput.Type;

export const CrmClientDeleteResult = Schema.Struct({
  deleted: Schema.Boolean,
  purged: Schema.Boolean,
  redactedAt: Schema.NullOr(IsoDateTime),
});
export type CrmClientDeleteResult = typeof CrmClientDeleteResult.Type;

export const CrmContactCreateInput = Schema.Struct({
  name: TrimmedNonEmptyString,
  roleTitle: Schema.optionalKey(Schema.NullOr(Schema.String)),
  email: Schema.optionalKey(Schema.NullOr(Schema.String)),
  phone: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type CrmContactCreateInput = typeof CrmContactCreateInput.Type;

export const CrmContactUpdateInput = Schema.Struct({
  name: Schema.optionalKey(TrimmedNonEmptyString),
  roleTitle: Schema.optionalKey(Schema.NullOr(Schema.String)),
  email: Schema.optionalKey(Schema.NullOr(Schema.String)),
  phone: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type CrmContactUpdateInput = typeof CrmContactUpdateInput.Type;

export const CrmContactDeleteResult = Schema.Struct({
  deleted: Schema.Boolean,
});
export type CrmContactDeleteResult = typeof CrmContactDeleteResult.Type;

export const CrmNoteCreateInput = Schema.Struct({
  body: TrimmedNonEmptyString,
  contactId: Schema.optionalKey(Schema.NullOr(CrmContactId)),
});
export type CrmNoteCreateInput = typeof CrmNoteCreateInput.Type;

export const CrmNoteUpdateInput = Schema.Struct({
  body: Schema.optionalKey(TrimmedNonEmptyString),
  contactId: Schema.optionalKey(Schema.NullOr(CrmContactId)),
});
export type CrmNoteUpdateInput = typeof CrmNoteUpdateInput.Type;

export const CrmNoteDeleteResult = Schema.Struct({
  deleted: Schema.Boolean,
});
export type CrmNoteDeleteResult = typeof CrmNoteDeleteResult.Type;

export const CrmClientThreadLinkInput = Schema.Struct({
  threadId: ThreadId,
});
export type CrmClientThreadLinkInput = typeof CrmClientThreadLinkInput.Type;

export const CrmClientThreadUnlinkResult = Schema.Struct({
  unlinked: Schema.Boolean,
});
export type CrmClientThreadUnlinkResult = typeof CrmClientThreadUnlinkResult.Type;

export const CrmClientInviteResult = Schema.Struct({
  clientId: CrmClientId,
  invitation: Invitation,
  code: TrimmedNonEmptyString,
});
export type CrmClientInviteResult = typeof CrmClientInviteResult.Type;

export const CrmPortalThread = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  status: OrchestrationV2ShellThreadStatus,
  archivedAt: Schema.NullOr(IsoDateTime),
  linkedAt: IsoDateTime,
  updatedAt: Schema.NullOr(IsoDateTime),
});
export type CrmPortalThread = typeof CrmPortalThread.Type;

export const CrmPortalView = Schema.Struct({
  projectTitle: Schema.NullOr(Schema.String),
  client: CrmClient,
  contacts: Schema.Array(CrmContact),
  threads: Schema.Array(CrmPortalThread),
});
export type CrmPortalView = typeof CrmPortalView.Type;
