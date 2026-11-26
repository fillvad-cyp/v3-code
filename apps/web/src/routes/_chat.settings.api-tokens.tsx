import { createFileRoute } from "@tanstack/react-router";

import { ApiTokensPage } from "../components/settings/ApiTokensSettings";

export const Route = createFileRoute("/_chat/settings/api-tokens")({
  component: ApiTokensPage,
});
