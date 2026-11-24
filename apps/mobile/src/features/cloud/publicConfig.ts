import * as Schema from "effect/Schema";

export class CloudPublicConfigMissingError extends Schema.TaggedError<CloudPublicConfigMissingError>()(
  "CloudPublicConfigMissingError",
  {
    key: Schema.Literal("T3CODE_CLERK_JWT_TEMPLATE"),
  },
) {
  override get message(): string {
    return `${this.key} is not configured.`;
  }
}

export interface CloudPublicConfig {
  readonly clerk: {
    readonly publishableKey: string | null;
    readonly jwtTemplate: string | null;
  };
  readonly relay: {
    readonly url: string | null;
  };
  readonly observability: {
    readonly tracesUrl: string | null;
    readonly tracesDataset: string | null;
    readonly tracesToken: string | null;
  };
}

const DISABLED_CLOUD_PUBLIC_CONFIG: CloudPublicConfig = {
  clerk: {
    publishableKey: null,
    jwtTemplate: null,
  },
  relay: {
    url: null,
  },
  observability: {
    tracesUrl: null,
    tracesDataset: null,
    tracesToken: null,
  },
};

/** V3 Code: cloud relay, Clerk auth, and Axiom tracing are permanently disabled. */
export function resolveCloudPublicConfig(_extra?: unknown): CloudPublicConfig {
  return DISABLED_CLOUD_PUBLIC_CONFIG;
}

export function hasCloudPublicConfig(): boolean {
  return false;
}

type Configured<T> = {
  readonly [Key in keyof T]: NonNullable<T[Key]>;
};

type TracingPublicConfig = Omit<CloudPublicConfig, "observability"> & {
  readonly observability: Configured<CloudPublicConfig["observability"]>;
};

export function hasTracingPublicConfig(
  _config: CloudPublicConfig = DISABLED_CLOUD_PUBLIC_CONFIG,
): _config is TracingPublicConfig {
  return false;
}

export function resolveRelayClerkTokenOptions(): never {
  throw new CloudPublicConfigMissingError({ key: "T3CODE_CLERK_JWT_TEMPLATE" });
}
