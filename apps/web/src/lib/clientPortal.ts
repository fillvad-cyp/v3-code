import {
  type CrmClientId,
  type CrmPortalView,
  EnvironmentHttpCommonError,
  EnvironmentHttpForbiddenError,
  type OrchestrationV2ShellThreadStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClientError } from "effect/http";
import { msg } from "gt-react";

import { PrimaryEnvironmentHttpClient } from "../environments/primary/httpClient";
import { runPrimaryHttp } from "./runtime";

const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);
const isEnvironmentHttpForbiddenError = Schema.is(EnvironmentHttpForbiddenError);

export function isClientPortalRoutePathname(pathname: string): boolean {
  return pathname === "/c" || pathname.startsWith("/c/");
}

export function buildClientPortalRoutePath(clientId: CrmClientId): string {
  return `/c/${encodeURIComponent(clientId)}`;
}

export async function fetchCrmPortal(clientId?: CrmClientId): Promise<CrmPortalView> {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) =>
        client.crm.getPortal({
          headers: {},
          query: clientId === undefined ? {} : { clientId },
        }),
      ),
    ),
  );
}

export type ClientPortalLoadErrorKind = "unauthorized" | "not_found" | "failed";

export function classifyClientPortalError(error: unknown): ClientPortalLoadErrorKind {
  if (isEnvironmentHttpCommonError(error)) {
    switch (error._tag) {
      case "EnvironmentAuthInvalidError":
        return "unauthorized";
      case "EnvironmentResourceNotFoundError":
      case "EnvironmentOperationForbiddenError":
      case "EnvironmentScopeRequiredError":
        return "not_found";
      default:
        return "failed";
    }
  }
  if (isEnvironmentHttpForbiddenError(error)) {
    return "not_found";
  }
  if (HttpClientError.isHttpClientError(error) && error.response !== undefined) {
    if (error.response.status === 401) return "unauthorized";
    if (error.response.status === 403 || error.response.status === 404) return "not_found";
  }
  return "failed";
}

export const PORTAL_THREAD_STATUS_LABELS = {
  idle: msg("Idle", { $context: "thread status" }),
  queued: msg("Queued", { $context: "thread status" }),
  preparing: msg("Preparing", { $context: "thread status" }),
  starting: msg("Starting", { $context: "thread status" }),
  running: msg("Running", { $context: "thread status" }),
  waiting: msg("Waiting", { $context: "thread status" }),
  completed: msg("Completed", { $context: "thread status" }),
  interrupted: msg("Interrupted", { $context: "thread status" }),
  failed: msg("Failed", { $context: "thread status" }),
  cancelled: msg("Cancelled", { $context: "thread status" }),
  rolled_back: msg("Rolled back", { $context: "thread status" }),
} as const satisfies Record<OrchestrationV2ShellThreadStatus, ReturnType<typeof msg>>;

export function portalThreadStatusBadgeVariant(
  status: OrchestrationV2ShellThreadStatus,
): "default" | "secondary" | "outline" | "success" | "warning" | "error" | "info" {
  switch (status) {
    case "running":
    case "starting":
    case "preparing":
      return "info";
    case "waiting":
    case "queued":
      return "warning";
    case "completed":
      return "success";
    case "failed":
    case "interrupted":
      return "error";
    case "idle":
    case "cancelled":
    case "rolled_back":
      return "secondary";
  }
}
