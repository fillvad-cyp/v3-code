import { createFileRoute } from "@tanstack/react-router";

import { RecoveryRouteSurface } from "../components/auth/RecoveryRouteSurface";
import { submitPasswordRecoveryConfirm } from "../environments/primary";

interface RecoverRouteSearch {
  readonly code?: string;
  readonly host?: string;
}

function parseOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export const Route = createFileRoute("/recover")({
  validateSearch: (search: Record<string, unknown>): RecoverRouteSearch => {
    const code = parseOptionalString(search.code);
    const host = parseOptionalString(search.host);
    return {
      ...(code !== undefined ? { code } : {}),
      ...(host !== undefined ? { host } : {}),
    };
  },
  component: RecoverRouteView,
});

function RecoverRouteView() {
  const search = Route.useSearch();

  const handleSubmitRecovery = async (input: {
    readonly code: string;
    readonly password: string;
  }) => {
    await submitPasswordRecoveryConfirm({
      code: input.code,
      password: input.password,
      ...(search.host ? { host: search.host } : {}),
    });
  };

  return (
    <RecoveryRouteSurface
      {...(search.code ? { initialCode: search.code } : {})}
      {...(search.host ? { host: search.host } : {})}
      onSubmitRecovery={handleSubmitRecovery}
    />
  );
}
