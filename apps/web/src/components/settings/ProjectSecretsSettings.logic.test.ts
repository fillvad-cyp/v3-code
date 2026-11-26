import {
  AuthAccessWriteScope,
  AuthEnvironmentMaintainScope,
  AuthProvidersManageScope,
  PrincipalId,
  ProjectId,
  type AuthSessionState,
  type MemberWithMemberships,
  type ProjectSecret,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveProjectSecretsPermissions,
  formatProjectSecretErrorMessage,
  projectSecretReferenceText,
  sortProjectSecrets,
  supportsProjectSecretsCapability,
  validateProjectSecretNameInput,
  validateProjectSecretValueInput,
} from "./ProjectSecretsSettings.logic";

const PROJECT_A = ProjectId.make("project-a");
const PROJECT_B = ProjectId.make("project-b");
const OWNER_ID = PrincipalId.make("owner");
const MEMBER_ID = PrincipalId.make("member-1");
const NOW = "2026-11-26T00:00:00.000Z";

const memberWithRoles: ReadonlyArray<MemberWithMemberships> = [
  {
    principal: {
      id: MEMBER_ID,
      kind: "member",
      displayName: "Alice",
      email: null,
      status: "active",
      ceiling: [AuthProvidersManageScope],
      accessRevision: 0,
      createdAt: NOW,
      updatedAt: NOW,
      removedAt: null,
    },
    memberships: [
      {
        projectId: PROJECT_A,
        principalId: MEMBER_ID,
        role: "admin",
        state: "active",
        invitedBy: OWNER_ID,
        expiresAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        projectId: PROJECT_B,
        principalId: MEMBER_ID,
        role: "developer",
        state: "active",
        invitedBy: OWNER_ID,
        expiresAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  },
];

const AUTH_DESCRIPTOR = {
  policy: "remote-reachable" as const,
  bootstrapMethods: [] as const,
  sessionMethods: [] as const,
  sessionCookieName: "t3_session",
  sessionTtlSeconds: 60,
};

describe("ProjectSecretsSettings.logic", () => {
  it("checks the projectSecrets capability flag", () => {
    expect(supportsProjectSecretsCapability(undefined)).toBe(false);
    expect(supportsProjectSecretsCapability({ repositoryIdentity: true })).toBe(false);
    expect(
      supportsProjectSecretsCapability({ repositoryIdentity: true, projectSecrets: false }),
    ).toBe(false);
    expect(
      supportsProjectSecretsCapability({ repositoryIdentity: true, projectSecrets: true }),
    ).toBe(true);
  });

  it("derives management permissions for owner, project admin, developer, and project-bound sessions", () => {
    const ownerSession: AuthSessionState = {
      authenticated: true,
      auth: AUTH_DESCRIPTOR,
      scopes: [AuthProvidersManageScope, AuthEnvironmentMaintainScope, AuthAccessWriteScope],
      principal: {
        id: OWNER_ID,
        kind: "owner",
        displayName: "Owner",
        email: null,
        status: "active",
        ceiling: [],
        accessRevision: 0,
        createdAt: NOW,
        updatedAt: NOW,
        removedAt: null,
      },
    };
    expect(
      deriveProjectSecretsPermissions({
        session: ownerSession,
        canManageProviders: true,
        projectId: PROJECT_B,
        members: [],
      }),
    ).toEqual({ isOwner: true, actorRole: "owner", canManage: true });

    const memberSession: AuthSessionState = {
      authenticated: true,
      auth: AUTH_DESCRIPTOR,
      scopes: [AuthProvidersManageScope],
      principal: memberWithRoles[0]!.principal,
      binding: { _tag: "principal" },
    };
    expect(
      deriveProjectSecretsPermissions({
        session: memberSession,
        canManageProviders: true,
        projectId: PROJECT_A,
        members: memberWithRoles,
      }),
    ).toEqual({ isOwner: false, actorRole: "admin", canManage: true });

    // Developer on project B cannot manage secrets even if their session holds providers:manage.
    expect(
      deriveProjectSecretsPermissions({
        session: memberSession,
        canManageProviders: true,
        projectId: PROJECT_B,
        members: memberWithRoles,
      }),
    ).toEqual({ isOwner: false, actorRole: "developer", canManage: false });

    // Missing providers:manage scope blocks management even for admin.
    expect(
      deriveProjectSecretsPermissions({
        session: memberSession,
        canManageProviders: false,
        projectId: PROJECT_A,
        members: memberWithRoles,
      }),
    ).toEqual({ isOwner: false, actorRole: "admin", canManage: false });

    // Project-bound session follows bound project role.
    const boundSession: AuthSessionState = {
      authenticated: true,
      auth: AUTH_DESCRIPTOR,
      scopes: [AuthProvidersManageScope],
      principal: memberWithRoles[0]!.principal,
      binding: { _tag: "projects", projects: [{ projectId: PROJECT_B, role: "admin" }] },
    };
    expect(
      deriveProjectSecretsPermissions({
        session: boundSession,
        canManageProviders: true,
        projectId: PROJECT_B,
        members: [],
      }),
    ).toEqual({ isOwner: false, actorRole: "admin", canManage: true });
    expect(
      deriveProjectSecretsPermissions({
        session: boundSession,
        canManageProviders: true,
        projectId: PROJECT_A,
        members: memberWithRoles,
      }),
    ).toEqual({ isOwner: false, actorRole: undefined, canManage: false });
  });

  it("validates secret names and values", () => {
    expect(validateProjectSecretNameInput("")).not.toBeNull();
    expect(validateProjectSecretNameInput("   ")).not.toBeNull();
    expect(validateProjectSecretNameInput("-invalid")).not.toBeNull();
    expect(validateProjectSecretNameInput("a/b")).not.toBeNull();
    expect(validateProjectSecretNameInput("has space")).not.toBeNull();
    expect(validateProjectSecretNameInput("OPENAI_API_KEY")).toBeNull();
    expect(validateProjectSecretNameInput("stripe.live-key_1")).toBeNull();

    expect(validateProjectSecretValueInput("")).not.toBeNull();
    expect(validateProjectSecretValueInput("x".repeat(65_537))).not.toBeNull();
    expect(validateProjectSecretValueInput("line1\nline2")).toBeNull();
  });

  it("sorts secrets alphabetically and formats secret://project references", () => {
    const secrets: ReadonlyArray<ProjectSecret> = [
      { projectId: PROJECT_A, name: "Z_KEY", fingerprint: "fpZ", updatedAt: NOW },
      { projectId: PROJECT_A, name: "A_KEY", fingerprint: "fpA", updatedAt: NOW },
    ];
    expect(sortProjectSecrets(secrets).map((entry) => entry.name)).toEqual(["A_KEY", "Z_KEY"]);
    expect(projectSecretReferenceText(PROJECT_A, "API_KEY")).toBe(
      "secret://project/project-a/API_KEY",
    );
  });

  it("maps authorization and not-found errors to friendly messages", () => {
    expect(formatProjectSecretErrorMessage(new Error("Missing project:secrets"))).toContain(
      "permission",
    );
    expect(formatProjectSecretErrorMessage(new Error("resource_not_found"))).toContain("not found");
  });
});
