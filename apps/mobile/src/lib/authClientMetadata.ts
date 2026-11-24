import type { AuthClientPresentationMetadata } from "@t3tools/contracts";

export function authClientMetadata(appVersion?: string): AuthClientPresentationMetadata {
  return {
    // oxlint-disable-next-line t3code/no-untranslated-copy -- product name
    label: "V3 Code Mobile",
    deviceType: "unknown",
    surface: "mobile",
    ...(appVersion ? { appVersion } : {}),
  };
}
