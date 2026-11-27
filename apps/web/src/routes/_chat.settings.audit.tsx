import { createFileRoute } from "@tanstack/react-router";

import { AuditLogPage } from "../components/settings/AuditLogSettings";

export const Route = createFileRoute("/_chat/settings/audit")({
  component: AuditLogPage,
});
