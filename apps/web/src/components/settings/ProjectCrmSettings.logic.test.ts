import { describe, expect, it } from "vite-plus/test";
import {
  type AuthSessionState,
  type CrmClient,
  CrmClientId,
  type MemberWithMemberships,
  PrincipalId,
  ProjectId,
  ceilingScopes,
  roleScopes,
} from "@t3tools/contracts";

import {
  deriveProjectCrmPermissions,
  formatCrmErrorMessage,
  sortCrmClients,
  supportsCrmCapability,
} from "./ProjectCrmSettings.logic";

const PROJECT_A = ProjectId.make("project-a");
const NOW = "2026-11-26T12:00:00.000Z";

function makeMember(
  id: PrincipalId,
  role: "admin" | "manager" | "developer" | "viewer",
  kind: "member" | "external" = "member",
): MemberWithMemberships {
  return {
    principal: {
      id,
      kind,
      displayName: id,
      email: null,
      status: "active",
      ceiling: [...ceilingScopes(kind === "external" ? "client" : "staff")],
      accessRevision: 0,
      createdAt: NOW,
      updatedAt: NOW,
      removedAt: null,
    },
    memberships: [
      {
        projectId: PROJECT_A,
        principalId: id,
        role,
        state: "active",
        invitedBy: PrincipalId.make("owner"),
        expiresAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  };
}

function makeSession(member: MemberWithMemberships): AuthSessionState {
  const role = member.memberships[0]!.role;
  return {
    authenticated: true,
    sessionMethod: "browser-session-cookie",
    scopes: [...roleScopes(role)],
    permissions: [],
    binding_kind: "principal",
    binding: { _tag: "principal" },
    role,
    principal: member.principal,
  } as unknown as AuthSessionState;
}

describe("ProjectCrmSettings.logic", () => {
  it("checks CRM capability advertisement", () => {
    expect(supportsCrmCapability(undefined)).toBe(false);
    expect(supportsCrmCapability({ repositoryIdentity: true })).toBe(false);
    expect(supportsCrmCapability({ repositoryIdentity: true, crm: true })).toBe(true);
    expect(supportsCrmCapability({ repositoryIdentity: true, members: true })).toBe(true);
  });

  it("derives CRM permissions across manager, developer, viewer, admin, and external roles", () => {
    const manager = makeMember(PrincipalId.make("mgr"), "manager");
    const developer = makeMember(PrincipalId.make("dev"), "developer");
    const admin = makeMember(PrincipalId.make("adm"), "admin");
    const external = makeMember(PrincipalId.make("ext"), "viewer", "external");
    const members = [manager, developer, admin, external];

    expect(
      deriveProjectCrmPermissions({
        session: makeSession(manager),
        canReadScope: true,
        canOperateScope: true,
        projectId: PROJECT_A,
        members,
      }),
    ).toMatchObject({ canRead: true, canWrite: true, canInvite: true, isExternal: false });

    expect(
      deriveProjectCrmPermissions({
        session: makeSession(admin),
        canReadScope: true,
        canOperateScope: true,
        projectId: PROJECT_A,
        members,
      }),
    ).toMatchObject({ canRead: true, canWrite: true, canInvite: true });

    expect(
      deriveProjectCrmPermissions({
        session: makeSession(developer),
        canReadScope: true,
        canOperateScope: true,
        projectId: PROJECT_A,
        members,
      }),
    ).toMatchObject({ canRead: true, canWrite: false, canInvite: false });

    expect(
      deriveProjectCrmPermissions({
        session: makeSession(external),
        canReadScope: true,
        canOperateScope: false,
        projectId: PROJECT_A,
        members,
      }),
    ).toMatchObject({ canRead: true, canWrite: false, canInvite: false, isExternal: true });
  });

  it("sorts active clients alphabetically ahead of purged clients", () => {
    const base: Omit<CrmClient, "id" | "name" | "redactedAt"> = {
      projectId: PROJECT_A,
      principalId: null,
      company: null,
      status: "active",
      emailMasked: null,
      emailFingerprint: null,
      phoneMasked: null,
      phoneFingerprint: null,
      createdBy: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const sorted = sortCrmClients([
      { ...base, id: CrmClientId.make("c3"), name: "Alpha Purged", redactedAt: NOW },
      { ...base, id: CrmClientId.make("c2"), name: "Zeta", redactedAt: null },
      { ...base, id: CrmClientId.make("c1"), name: "Beta", redactedAt: null },
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual(["c1", "c2", "c3"]);
  });

  it("formats forbidden and redacted CRM errors cleanly", () => {
    expect(formatCrmErrorMessage(new Error("Missing project:crm.write"))).toContain("permission");
    expect(formatCrmErrorMessage(new Error("Client has been purged"))).toContain("purged");
  });
});
