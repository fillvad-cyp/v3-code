import {
  CrmClientId,
  EnvironmentAuthInvalidError,
  EnvironmentHttpForbiddenError,
  EnvironmentResourceNotFoundError,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildClientPortalRoutePath,
  classifyClientPortalError,
  isClientPortalRoutePathname,
  portalThreadStatusBadgeVariant,
} from "./clientPortal";

describe("clientPortal helpers", () => {
  it("recognizes /c and /c/:clientId pathnames", () => {
    expect(isClientPortalRoutePathname("/c")).toBe(true);
    expect(isClientPortalRoutePathname("/c/client-123")).toBe(true);
    expect(isClientPortalRoutePathname("/chat")).toBe(false);
    expect(isClientPortalRoutePathname("/")).toBe(false);
    expect(isClientPortalRoutePathname("/popout/thread/t1")).toBe(false);
  });

  it("builds encoded client portal paths", () => {
    expect(buildClientPortalRoutePath(CrmClientId.make("client/1"))).toBe("/c/client%2F1");
  });

  it("classifies HTTP API errors for portal rendering", () => {
    expect(
      classifyClientPortalError(
        new EnvironmentAuthInvalidError({
          code: "auth_invalid",
          reason: "invalid_credential",
          traceId: "t1",
        }),
      ),
    ).toBe("unauthorized");

    expect(
      classifyClientPortalError(
        new EnvironmentResourceNotFoundError({
          code: "not_found",
          reason: "resource_not_found",
          traceId: "t2",
        }),
      ),
    ).toBe("not_found");

    expect(
      classifyClientPortalError(new EnvironmentHttpForbiddenError({ message: "Forbidden" })),
    ).toBe("not_found");

    expect(classifyClientPortalError(new Error("boom"))).toBe("failed");
  });

  it("maps thread statuses to badge variants", () => {
    expect(portalThreadStatusBadgeVariant("running")).toBe("info");
    expect(portalThreadStatusBadgeVariant("waiting")).toBe("warning");
    expect(portalThreadStatusBadgeVariant("completed")).toBe("success");
    expect(portalThreadStatusBadgeVariant("failed")).toBe("error");
    expect(portalThreadStatusBadgeVariant("idle")).toBe("secondary");
  });
});
