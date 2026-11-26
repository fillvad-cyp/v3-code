import { CrmClientId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { ClientPortalView } from "../components/crm/ClientPortalView";

export const Route = createFileRoute("/c/$clientId")({
  component: ClientPortalRouteView,
});

function ClientPortalRouteView() {
  const { clientId } = Route.useParams();
  const { authGateState } = Route.useRouteContext();
  const authMode =
    authGateState.status === "requires-auth" ? authGateState.auth.authMode : undefined;

  return (
    <ClientPortalView
      clientId={CrmClientId.make(clientId)}
      authGateStatus={authGateState.status}
      {...(authMode === undefined ? {} : { authMode })}
    />
  );
}
