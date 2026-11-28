import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type PromptCostAssessment,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildPromptCostAttachments,
  buildPromptCostKey,
  buildPromptCostPromptHash,
  chipState,
  createAppliedHashRecorder,
  fnv1aHash,
  formatCost,
  MAX_PROMPT_COST_ATTACHMENTS,
  promptCostAttachmentSignature,
  savePercent,
  shouldAutoSwitchPromptCost,
} from "./promptCostChip.logic";

const ENV_ID = EnvironmentId.make("env-1");
const INSTANCE_A = ProviderInstanceId.make("claudeAgent");
const INSTANCE_B = ProviderInstanceId.make("codex");
const THREAD_ID = ThreadId.make("thread-1");

function makeAssessment(overrides: Partial<PromptCostAssessment> = {}): PromptCostAssessment {
  return {
    inputTokens: { context: 12_000, prompt: 420, attachments: 0, output: 800 },
    estimate: { medianUsd: 0.18, p90Usd: 0.42 },
    confidence: "high",
    basis: ["ownThread", "rates"],
    classifier: null,
    alternatives: [],
    recommendation: null,
    priced: true,
    note: null,
    ...overrides,
  };
}

const SAME_FIT_ALT: PromptCostAssessment["alternatives"][number] = {
  instanceId: INSTANCE_A,
  model: "claude-haiku-4-5",
  label: "Claude Haiku 4.5",
  estimate: { medianUsd: 0.04, p90Usd: 0.09 },
  saveRatio: 0.78,
  verdict: "sameFit",
  evidence: { similarRuns: 5, successRate: 0.8, medianCostUsd: 0.04 },
};

describe("formatCost", () => {
  it("formats sub-dime prices with two significant digits", () => {
    expect(formatCost(0.0042)).toBe("$0.0042");
    expect(formatCost(0.00423)).toBe("$0.0042");
    expect(formatCost(0.00051)).toBe("$0.00051");
    expect(formatCost(0.0123)).toBe("$0.012");
    expect(formatCost(0.0996)).toBe("$0.10");
  });

  it("formats standard USD prices with two decimal places", () => {
    expect(formatCost(0.1)).toBe("$0.10");
    expect(formatCost(0.31)).toBe("$0.31");
    expect(formatCost(1.5)).toBe("$1.50");
    expect(formatCost(12.345)).toBe("$12.35");
  });

  it("never returns 0 for zero, negative, tiny, or non-finite values", () => {
    expect(formatCost(0)).toBe("<$0.0001");
    expect(formatCost(-1)).toBe("<$0.0001");
    expect(formatCost(0.00001)).toBe("<$0.0001");
    expect(formatCost(Number.NaN)).toBe("<$0.0001");
    expect(formatCost(Number.POSITIVE_INFINITY)).toBe("<$0.0001");
  });
});

describe("savePercent", () => {
  it("rounds ratio to percentage and clamps out-of-range values", () => {
    expect(savePercent(0.624)).toBe(62);
    expect(savePercent(0.626)).toBe(63);
    expect(savePercent(0)).toBe(0);
    expect(savePercent(-0.2)).toBe(0);
    expect(savePercent(1.5)).toBe(100);
    expect(savePercent(Number.NaN)).toBe(0);
  });
});

describe("chipState", () => {
  it("returns hidden when disabled or idle with no data", () => {
    expect(
      chipState({ enabled: false, isPending: true, error: null, assessment: makeAssessment() }),
    ).toBe("hidden");
    expect(chipState({ enabled: true, isPending: false, error: null, assessment: null })).toBe(
      "hidden",
    );
  });

  it("returns loading and error when no assessment has arrived yet", () => {
    expect(chipState({ enabled: true, isPending: true, error: null, assessment: null })).toBe(
      "loading",
    );
    expect(
      chipState({ enabled: true, isPending: false, error: "Network failed", assessment: null }),
    ).toBe("error");
  });

  it("distinguishes unpriced, priced, and recommendation assessments", () => {
    expect(
      chipState({
        enabled: true,
        isPending: false,
        error: null,
        assessment: makeAssessment({ priced: false }),
      }),
    ).toBe("unpriced");
    expect(
      chipState({
        enabled: true,
        isPending: false,
        error: null,
        assessment: makeAssessment({ priced: true, recommendation: null }),
      }),
    ).toBe("priced");
    expect(
      chipState({
        enabled: true,
        isPending: false,
        error: null,
        assessment: makeAssessment({ priced: true, recommendation: SAME_FIT_ALT }),
      }),
    ).toBe("recommendation");
  });
});

describe("shouldAutoSwitchPromptCost", () => {
  const base = {
    mode: "auto" as const,
    assessment: makeAssessment({ confidence: "high", recommendation: SAME_FIT_ALT }),
    selectedInstanceId: INSTANCE_A,
    selectedModel: "claude-opus-4-6",
    lockedProvider: null,
    multipleModelSelections: null,
    promptHash: "abcd1234",
    hasAppliedHash: false,
  };

  it("returns true for auto mode with medium or high confidence sameFit differing from selection", () => {
    expect(shouldAutoSwitchPromptCost(base)).toBe(true);
    expect(
      shouldAutoSwitchPromptCost({
        ...base,
        assessment: makeAssessment({ confidence: "medium", recommendation: SAME_FIT_ALT }),
      }),
    ).toBe(true);
  });

  it("skips when mode is not auto, locked, multi-model, or already applied", () => {
    expect(shouldAutoSwitchPromptCost({ ...base, mode: "suggest" })).toBe(false);
    expect(shouldAutoSwitchPromptCost({ ...base, mode: "off" })).toBe(false);
    expect(
      shouldAutoSwitchPromptCost({
        ...base,
        lockedProvider: ProviderDriverKind.make("claudeAgent"),
      }),
    ).toBe(false);
    expect(
      shouldAutoSwitchPromptCost({
        ...base,
        multipleModelSelections: [{ instanceId: INSTANCE_A, model: "claude-opus-4-6" }],
      }),
    ).toBe(false);
    expect(shouldAutoSwitchPromptCost({ ...base, hasAppliedHash: true })).toBe(false);
    expect(shouldAutoSwitchPromptCost({ ...base, promptHash: null })).toBe(false);
  });

  it("skips when confidence is low/none, verdict is not sameFit, unpriced, or already selected", () => {
    expect(
      shouldAutoSwitchPromptCost({
        ...base,
        assessment: makeAssessment({ confidence: "low", recommendation: SAME_FIT_ALT }),
      }),
    ).toBe(false);
    expect(
      shouldAutoSwitchPromptCost({
        ...base,
        assessment: makeAssessment({ confidence: "none", recommendation: SAME_FIT_ALT }),
      }),
    ).toBe(false);
    expect(
      shouldAutoSwitchPromptCost({
        ...base,
        assessment: makeAssessment({
          confidence: "high",
          recommendation: { ...SAME_FIT_ALT, verdict: "risky" },
        }),
      }),
    ).toBe(false);
    expect(
      shouldAutoSwitchPromptCost({
        ...base,
        assessment: makeAssessment({
          confidence: "high",
          priced: false,
          recommendation: SAME_FIT_ALT,
        }),
      }),
    ).toBe(false);
    expect(
      shouldAutoSwitchPromptCost({
        ...base,
        selectedInstanceId: SAME_FIT_ALT.instanceId,
        selectedModel: SAME_FIT_ALT.model,
      }),
    ).toBe(false);
  });
});

describe("createAppliedHashRecorder", () => {
  it("records applied hashes, deduplicates, and evicts oldest past maxEntries", () => {
    const recorder = createAppliedHashRecorder(2);
    expect(recorder.has("a")).toBe(false);
    recorder.mark("a");
    recorder.mark("a");
    expect(recorder.size()).toBe(1);
    expect(recorder.has("a")).toBe(true);

    recorder.mark("b");
    recorder.mark("c");
    expect(recorder.size()).toBe(2);
    expect(recorder.has("a")).toBe(false);
    expect(recorder.has("b")).toBe(true);
    expect(recorder.has("c")).toBe(true);

    recorder.clear();
    expect(recorder.size()).toBe(0);
    expect(recorder.has("b")).toBe(false);
  });
});

describe("key and attachment helpers", () => {
  it("hashes deterministically with FNV-1a and builds stable query keys", () => {
    const hashA = fnv1aHash("fix the login bug");
    const hashB = fnv1aHash("fix the login bug");
    const hashC = fnv1aHash("fix the logout bug");
    expect(hashA).toBe(hashB);
    expect(hashA).not.toBe(hashC);
    expect(hashA).toMatch(/^[0-9a-f]{8}$/);

    const key1 = buildPromptCostKey(ENV_ID, {
      providerInstanceId: INSTANCE_A,
      model: "claude-opus-4-6",
      threadId: THREAD_ID,
      compactFirst: false,
      useClassifier: false,
      promptText: "fix the login bug",
      attachments: [{ kind: "file", sizeBytes: 1024 }],
    });
    const key1WithClassifier = buildPromptCostKey(ENV_ID, {
      providerInstanceId: INSTANCE_A,
      model: "claude-opus-4-6",
      threadId: THREAD_ID,
      compactFirst: false,
      useClassifier: true,
      promptText: "fix the login bug",
      attachments: [{ kind: "file", sizeBytes: 1024 }],
    });
    const key2 = buildPromptCostKey(ENV_ID, {
      providerInstanceId: INSTANCE_B,
      model: "claude-opus-4-6",
      threadId: null,
      compactFirst: true,
      useClassifier: true,
      promptText: "fix the login bug",
      attachments: [],
    });
    expect(key1).toBe(
      `${ENV_ID}|${INSTANCE_A}|claude-opus-4-6|${THREAD_ID}|false|false|${hashA}|file:1024`,
    );
    expect(key1WithClassifier).toBe(
      `${ENV_ID}|${INSTANCE_A}|claude-opus-4-6|${THREAD_ID}|false|true|${hashA}|file:1024`,
    );
    expect(key1WithClassifier).not.toBe(key1);
    expect(key2).toBe(`${ENV_ID}|${INSTANCE_B}|claude-opus-4-6||true|true|${hashA}|`);
    expect(
      promptCostAttachmentSignature([
        { kind: "file", sizeBytes: 12 },
        { kind: "image", sizeBytes: 34 },
      ]),
    ).toBe("file:12,image:34");
    expect(buildPromptCostPromptHash("hello world", [])).toBe(fnv1aHash("hello world|"));
  });

  it("maps files and images and caps attachments at 20", () => {
    const files = Array.from({ length: 15 }, (_, index) => ({ sizeBytes: index + 1 }));
    const images = Array.from({ length: 10 }, (_, index) => ({ sizeBytes: 100 + index }));
    const mapped = buildPromptCostAttachments(files, images);
    expect(mapped).toHaveLength(MAX_PROMPT_COST_ATTACHMENTS);
    expect(mapped.slice(0, 15).every((item) => item.kind === "file")).toBe(true);
    expect(mapped.slice(15).every((item) => item.kind === "image")).toBe(true);
  });
});
