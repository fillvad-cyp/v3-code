import { describe, expect, it } from "vite-plus/test";

import {
  capabilitiesForRole,
  ceilingScopes,
  intersectScopes,
  roleAtLeast,
  roleFitsCeiling,
  ROLE_SCOPES,
  roleScopes,
  scopesFitCeiling,
} from "./roleScopes.ts";
import { PrincipalCeilingTemplate, ProjectRole } from "./membership.ts";
import { AuthEnvironmentMaintainScope, AuthRelayConfigureScope } from "./auth.ts";

const projectRoles: ReadonlyArray<ProjectRole> = [
  "viewer",
  "operator",
  "developer",
  "manager",
  "admin",
];
const templates: ReadonlyArray<PrincipalCeilingTemplate> = ["staff", "restricted", "client"];

const staff = ceilingScopes("staff");

describe("role scopes", () => {
  it("lets each role do everything the one below it does", () => {
    for (const [lower, higher] of [
      ["viewer", "operator"],
      ["operator", "developer"],
      ["developer", "admin"],
    ] as const) {
      for (const scope of roleScopes(lower)) expect(roleScopes(higher)).toContain(scope);
    }
  });

  it("keeps manager on its CRM branch", () => {
    expect(roleScopes("manager")).toContain("orchestration:operate");
    expect(roleScopes("manager")).not.toContain("terminal:operate");
    expect(roleScopes("manager")).not.toContain("filesystem:write");
    expect(roleScopes("manager")).not.toContain("settings:write");
    expect(capabilitiesForRole("manager")).toContain("project:crm.write");
    expect(capabilitiesForRole("viewer")).not.toContain("project:thread.operate");
  });

  it("gives access management to admins and nobody below", () => {
    expect(roleScopes("admin")).toContain("access:write");
    expect(roleScopes("developer")).toContain("access:read");
    expect(roleScopes("developer")).not.toContain("access:write");
  });

  it("keeps environment scopes for the owner only", () => {
    expect(roleScopes("owner")).toContain(AuthEnvironmentMaintainScope);
    expect(roleScopes("owner")).toContain(AuthRelayConfigureScope);
    for (const role of projectRoles) {
      expect(roleScopes(role)).not.toContain(AuthEnvironmentMaintainScope);
      expect(roleScopes(role)).not.toContain(AuthRelayConfigureScope);
    }
  });

  it("fits every project role inside the staff ceiling", () => {
    for (const role of projectRoles) expect(roleFitsCeiling(staff, role)).toBe(true);
    expect(roleFitsCeiling(ceilingScopes("client"), "developer")).toBe(false);
    expect(scopesFitCeiling(staff, roleScopes("admin"))).toBe(true);
  });

  it("narrows a requested set to the ceiling", () => {
    expect(intersectScopes(roleScopes("developer"), ceilingScopes("client"))).toEqual([
      "access:read",
      "filesystem:read",
      "orchestration:read",
    ]);
  });

  it("orders roles so nobody grants above their own", () => {
    expect(roleAtLeast("admin", "developer")).toBe(true);
    expect(roleAtLeast("developer", "admin")).toBe(false);
    expect(roleAtLeast("owner", "admin")).toBe(true);
    expect(roleAtLeast("operator", "admin")).toBe(false);
  });

  it("has a ceiling template for every role pair the matrix names", () => {
    for (const template of templates) {
      expect(ceilingScopes(template).length).toBeGreaterThan(0);
      expect(ROLE_SCOPES.viewer.every((scope) => ceilingScopes(template).includes(scope))).toBe(
        true,
      );
    }
  });
});
