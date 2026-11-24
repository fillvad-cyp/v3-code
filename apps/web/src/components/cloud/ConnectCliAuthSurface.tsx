import { useGT } from "gt-react";

import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";

export function ConnectCliAuthorizeSurface() {
  const gt = useGT();
  return (
    <StandalonePage>
      <StandalonePageHeader
        context={gt("Browser authorization")}
        title={gt("Cloud relay is disabled")}
        description={gt(
          "V3 Code does not use T3 Connect or Clerk. Connect over localhost, LAN, Tailscale, or SSH instead.",
        )}
      />
    </StandalonePage>
  );
}
