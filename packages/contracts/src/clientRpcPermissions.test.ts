import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "./auth.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import {
  PromptCostAlternative,
  PromptCostAssessment,
  PromptCostEstimate,
  PromptCostEvidence,
} from "./promptCost.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { WS_METHODS } from "./rpc.ts";

describe("clientRpcRequiredScopes", () => {
  it("requires operate scope for serverPredictPromptCost only when useClassifier is true", () => {
    expect(
      clientRpcRequiredScopes(WS_METHODS.serverPredictPromptCost, { useClassifier: true }),
    ).toEqual([AuthOrchestrationOperateScope]);
    expect(
      clientRpcRequiredScopes(WS_METHODS.serverPredictPromptCost, { useClassifier: false }),
    ).toEqual([AuthOrchestrationReadScope]);
    expect(clientRpcRequiredScopes(WS_METHODS.serverPredictPromptCost, {})).toEqual([
      AuthOrchestrationReadScope,
    ]);
    expect(clientRpcRequiredScopes(WS_METHODS.serverPredictPromptCost, undefined)).toEqual([
      AuthOrchestrationReadScope,
    ]);
    expect(clientRpcRequiredScopes(WS_METHODS.serverPredictPromptCost, null)).toEqual([
      AuthOrchestrationReadScope,
    ]);
    expect(
      clientRpcRequiredScopes(WS_METHODS.serverPredictPromptCost, { useClassifier: "true" }),
    ).toEqual([AuthOrchestrationReadScope]);
  });
});

describe("promptCost contracts", () => {
  const decodeEstimate = Schema.decodeUnknownSync(PromptCostEstimate);
  const decodeEvidence = Schema.decodeUnknownSync(PromptCostEvidence);
  const decodeAlternative = Schema.decodeUnknownSync(PromptCostAlternative);
  const decodeAssessment = Schema.decodeUnknownSync(PromptCostAssessment);

  it("enforces finite non-negative USD bounds and 0..1 ratios", () => {
    expect(decodeEstimate({ medianUsd: 0, p90Usd: 1.5 })).toEqual({ medianUsd: 0, p90Usd: 1.5 });
    expect(() => decodeEstimate({ medianUsd: -0.01, p90Usd: 1 })).toThrow();
    expect(() => decodeEstimate({ medianUsd: Number.NaN, p90Usd: 1 })).toThrow();
    expect(() => decodeEstimate({ medianUsd: 1, p90Usd: Number.POSITIVE_INFINITY })).toThrow();

    expect(decodeEvidence({ similarRuns: 3, successRate: 0.75, medianCostUsd: 0.1 })).toEqual({
      similarRuns: 3,
      successRate: 0.75,
      medianCostUsd: 0.1,
    });
    expect(() =>
      decodeEvidence({ similarRuns: 3, successRate: -0.1, medianCostUsd: 0.1 }),
    ).toThrow();
    expect(() =>
      decodeEvidence({ similarRuns: 3, successRate: 1.1, medianCostUsd: 0.1 }),
    ).toThrow();
    expect(() => decodeEvidence({ similarRuns: 3, successRate: 0.5, medianCostUsd: -1 })).toThrow();

    const baseAlt = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-haiku-4-5",
      label: "Claude Haiku 4.5",
      estimate: { medianUsd: 0.05, p90Usd: 0.1 },
      saveRatio: 0.6,
      verdict: "sameFit" as const,
      evidence: { similarRuns: 4, successRate: 1, medianCostUsd: 0.05 },
    };
    expect(decodeAlternative(baseAlt).saveRatio).toBe(0.6);
    expect(() => decodeAlternative({ ...baseAlt, saveRatio: -0.01 })).toThrow();
    expect(() => decodeAlternative({ ...baseAlt, saveRatio: 1.01 })).toThrow();

    const baseAssessment = {
      inputTokens: { context: 0, prompt: 10, attachments: 0, output: 10 },
      estimate: { medianUsd: 0.01, p90Usd: 0.02 },
      confidence: "none" as const,
      basis: [] as const,
      classifier: null,
      alternatives: [] as const,
      recommendation: null,
      priced: false,
      note: "noPrice" as const,
    };
    expect(decodeAssessment(baseAssessment).note).toBe("noPrice");
    expect(decodeAssessment({ ...baseAssessment, note: "classifierUnavailable" }).note).toBe(
      "classifierUnavailable",
    );
    expect(() => decodeAssessment({ ...baseAssessment, note: "freeform text" })).toThrow();
  });
});
