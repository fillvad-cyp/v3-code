// V3 Code permanently disables outbound relay tracing.
import { nodeProcessRuntimeAttributes } from "@t3tools/shared/observability";
import * as RelayTracing from "@t3tools/shared/relayTracing";

export const relayLayer = (
  resource: Omit<RelayTracing.RelayClientTracingResource, "serviceInstanceId">,
  _tracingConfig?: unknown,
) =>
  RelayTracing.layer(null, {
    ...resource,
    serviceInstanceId: "v3code",
  });

export const layerHeadlessRelayClient = relayLayer({
  serviceName: "v3code-server",
  runtime: "node",
  attributes: nodeProcessRuntimeAttributes(),
  client: "headless-cli",
});

export const layerServerRelayBroker = relayLayer({
  serviceName: "v3code-server",
  runtime: "node",
  attributes: nodeProcessRuntimeAttributes(),
  client: "environment-server",
  component: "relay-broker",
});
