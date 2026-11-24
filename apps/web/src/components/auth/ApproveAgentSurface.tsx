import { useGT } from "gt-react";

import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";

export function ApproveAgentSurface() {
  const gt = useGT();
  return (
    <StandalonePage>
      <StandalonePageHeader
        context={gt("Agent sign-in")}
        title={gt("Cloud relay sign-in is disabled")}
        description={gt(
          "V3 Code does not connect to T3 Connect. Approve agent access directly on your local or Tailscale V3 Code server.",
        )}
      />
    </StandalonePage>
  );
}
