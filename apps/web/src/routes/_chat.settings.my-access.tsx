import { createFileRoute } from "@tanstack/react-router";

import { MyAccessPage } from "../components/settings/MyAccessSettings";

export const Route = createFileRoute("/_chat/settings/my-access")({
  component: MyAccessPage,
});
