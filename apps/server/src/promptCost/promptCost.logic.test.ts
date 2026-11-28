import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, type PromptCostAlternative } from "@t3tools/contracts";

import {
  blendedPerToken,
  chooseRecommendation,
  confidenceFor,
  estimateAttachmentTokens,
  estimateTokens,
  jaccard,
  percentile,
  pickAlternatives,
  type PickAlternativeCandidate,
  trigrams,
  verdictFor,
} from "./promptCost.logic.ts";

const INSTANCE = ProviderInstanceId.make("claudeAgent");

describe("promptCost.logic", () => {
  it("estimates text tokens with 3.6 chars/token ceiling and 400k cap", () => {
    assert.strictEqual(estimateTokens(""), 0);
    assert.strictEqual(estimateTokens("a"), 1);
    assert.strictEqual(estimateTokens("1234567890"), Math.ceil(10 / 3.6));
    assert.strictEqual(estimateTokens("x".repeat(2_000_000)), 400_000);
  });

  it("estimates attachment tokens with per-file, image, and total caps", () => {
    assert.strictEqual(estimateAttachmentTokens([]), 0);
    assert.strictEqual(
      estimateAttachmentTokens([
        { kind: "file", sizeBytes: 45 },
        { kind: "image", sizeBytes: 999_999 },
      ]),
      10 + 1_500,
    );
    assert.strictEqual(estimateAttachmentTokens([{ kind: "file", sizeBytes: 500_000 }]), 25_000);
    assert.strictEqual(
      estimateAttachmentTokens(
        Array.from({ length: 10 }, () => ({ kind: "file" as const, sizeBytes: 500_000 })),
      ),
      120_000,
    );
  });

  it("computes normalized lowercase word trigrams and jaccard similarity", () => {
    const a = trigrams("Fix the broken login flow in AuthService!");
    const b = trigrams("fix the broken login flow in authservice");
    const c = trigrams("Refactor database connection pooling layer");
    assert.strictEqual(jaccard(a, b), 1);
    assert.strictEqual(jaccard(a, c), 0);
    assert.strictEqual(jaccard(trigrams(""), a), 0);
    assert.isAbove(
      jaccard(
        trigrams("fix the broken login flow in authservice"),
        trigrams("fix the broken login flow in billing"),
      ),
      0.5,
    );
  });

  it("computes blended token rate and linear-interpolated percentiles", () => {
    assert.closeTo(blendedPerToken({ inputPerToken: 10e-6, outputPerToken: 50e-6 }), 20e-6, 1e-12);
    assert.strictEqual(percentile([], 0.5), 0);
    assert.strictEqual(percentile([0.42], 0.5), 0.42);
    assert.strictEqual(percentile([0.42], 0.9), 0.42);
    assert.closeTo(percentile([4, 1, 3, 2], 0.5), 2.5, 1e-12);
    assert.closeTo(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9.1, 1e-12);
  });

  it("filters, dedupes, sorts, and caps alternatives to 3", () => {
    const targetRate = {
      inputPerToken: 10e-6,
      cacheReadPerToken: 1e-6,
      outputPerToken: 50e-6,
    };
    const targetEstimate = { medianUsd: 1.0, p90Usd: 1.5 };
    const makeCandidate = (
      model: string,
      inputPerToken: number,
      outputPerToken: number,
      medianUsd: number,
    ): PickAlternativeCandidate => ({
      instanceId: INSTANCE,
      model,
      label: model,
      rate: { inputPerToken, cacheReadPerToken: inputPerToken * 0.1, outputPerToken },
      estimate: { medianUsd, p90Usd: medianUsd * 1.4 },
      verdict: "untested",
      evidence: { similarRuns: 0, successRate: 0, medianCostUsd: 0 },
    });

    const picked = pickAlternatives({
      targetRate,
      targetEstimate,
      candidates: [
        { ...makeCandidate("unpriced", 1e-6, 5e-6, 0.1), rate: null },
        makeCandidate("too-expensive-blended", 6e-6, 30e-6, 0.4),
        makeCandidate("not-cheaper", 1e-6, 5e-6, 1.2),
        makeCandidate("cheap-b", 3e-6, 15e-6, 0.3),
        makeCandidate("cheap-a", 1e-6, 5e-6, 0.1),
        makeCandidate("cheap-a", 1e-6, 5e-6, 0.15),
        makeCandidate("cheap-c", 2e-6, 10e-6, 0.2),
        makeCandidate("cheap-d", 4e-6, 20e-6, 0.4),
      ],
    });

    assert.deepStrictEqual(
      picked.map((alt) => alt.model),
      ["cheap-a", "cheap-c", "cheap-b"],
    );
    assert.closeTo(picked[0]!.saveRatio, 0.9, 1e-12);
  });

  it("computes verdictFor and confidenceFor thresholds", () => {
    assert.strictEqual(verdictFor({ similarRuns: 3, successRate: 0.7 }), "sameFit");
    assert.strictEqual(verdictFor({ similarRuns: 5, successRate: 0.69 }), "risky");
    assert.strictEqual(verdictFor({ similarRuns: 2, successRate: 1 }), "untested");

    assert.strictEqual(confidenceFor({ similarRuns: 8 }), "high");
    assert.strictEqual(confidenceFor({ similarRuns: 3 }), "medium");
    assert.strictEqual(confidenceFor({ similarRuns: 1 }), "low");
    assert.strictEqual(confidenceFor({ similarRuns: 0 }), "none");
  });

  it("applies chooseRecommendation rules across verdicts, confidence, and complexity", () => {
    const alt = (
      model: string,
      medianUsd: number,
      saveRatio: number,
      verdict: PromptCostAlternative["verdict"],
    ): PromptCostAlternative => ({
      instanceId: INSTANCE,
      model,
      label: model,
      estimate: { medianUsd, p90Usd: medianUsd * 1.5 },
      saveRatio,
      verdict,
      evidence: {
        similarRuns: verdict === "untested" ? 0 : 4,
        successRate: 0.9,
        medianCostUsd: medianUsd,
      },
    });

    // Cheapest sameFit with saveRatio >= 0.5 wins.
    assert.strictEqual(
      chooseRecommendation({
        alternatives: [
          alt("expensive-fit", 0.4, 0.6, "sameFit"),
          alt("cheap-fit", 0.2, 0.8, "sameFit"),
        ],
        confidence: "low",
        classifierComplexity: null,
      })?.model,
      "cheap-fit",
    );

    // Complex prompts require sameFit saveRatio >= 0.6.
    assert.isNull(
      chooseRecommendation({
        alternatives: [alt("fit-55", 0.45, 0.55, "sameFit")],
        confidence: "high",
        classifierComplexity: "complex",
      }),
    );
    assert.strictEqual(
      chooseRecommendation({
        alternatives: [alt("fit-60", 0.4, 0.6, "sameFit")],
        confidence: "high",
        classifierComplexity: "complex",
      })?.model,
      "fit-60",
    );

    // Untested >= 0.6 allowed only for medium/high confidence and non-complex.
    assert.strictEqual(
      chooseRecommendation({
        alternatives: [alt("untested-65", 0.35, 0.65, "untested")],
        confidence: "medium",
        classifierComplexity: "simple",
      })?.model,
      "untested-65",
    );
    assert.isNull(
      chooseRecommendation({
        alternatives: [alt("untested-65", 0.35, 0.65, "untested")],
        confidence: "low",
        classifierComplexity: "simple",
      }),
    );
    assert.isNull(
      chooseRecommendation({
        alternatives: [alt("untested-65", 0.35, 0.65, "untested")],
        confidence: "high",
        classifierComplexity: "complex",
      }),
    );
    assert.isNull(
      chooseRecommendation({
        alternatives: [alt("risky-90", 0.1, 0.9, "risky")],
        confidence: "high",
        classifierComplexity: "simple",
      }),
    );
  });
});
