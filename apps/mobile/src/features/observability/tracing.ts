import { RelayClientTracer } from "@t3tools/shared/relayTracing";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

export interface TracingConfig {
  readonly tracesUrl: string;
  readonly tracesDataset: string;
  readonly tracesToken: string;
}

export interface TracingResource {
  readonly serviceVersion?: string;
  readonly serviceInstanceId: string;
  readonly appVariant: string;
}

/** V3 Code: outbound Axiom relay tracing is permanently disabled. */
export function resolveTracingConfig(): TracingConfig | null {
  return null;
}

export function layerFromConfig(_config: TracingConfig | null, _resource: TracingResource) {
  return Layer.succeed(RelayClientTracer, Option.none());
}

export const layer = Layer.succeed(RelayClientTracer, Option.none());
