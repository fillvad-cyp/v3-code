import { createFileRoute } from "@tanstack/react-router";

import { RolesPermissionsPage } from "../components/settings/RolesPermissionsSettings";

export const Route = createFileRoute("/_chat/settings/roles")({
  component: RolesPermissionsPage,
});
