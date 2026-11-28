import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type PromptCostAssessment,
  type PromptCostInput,
  type ServerConfig,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";
import { Atom } from "effect/reactivity";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import {
  ComposerPromptCost,
  type ComposerPromptCostProps,
  type ComposerPromptCostSwitchedFrom,
} from "./ComposerPromptCost";

const hookMocks = vi.hoisted(() => ({
  supportsPromptCost: true,
  canUseClassifier: true,
  assessment: null as PromptCostAssessment | null,
  lastInput: null as PromptCostInput | null,
}));

const supportsAtom = Atom.make({
  environment: { capabilities: { promptCostClassifier: true } },
} as unknown as ServerConfig | null);
const unsupportedAtom = Atom.make({
  environment: { capabilities: { promptCostClassifier: false } },
} as unknown as ServerConfig | null);
const grantedAtom = Atom.make(true);
const deniedAtom = Atom.make(false);

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      configValueAtom: (() =>
        hookMocks.supportsPromptCost ? supportsAtom : unsupportedAtom) as never,
    },
  };
});

vi.mock(import("@t3tools/client-runtime/state/runtime"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    createCommandPermissions: (() => ({
      permissionAtom: () => (hookMocks.canUseClassifier ? grantedAtom : deniedAtom),
      requiredScopes: () => [],
      authorize: () => undefined,
    })) as never,
  };
});

vi.mock(import("../../state/queries"), async (original) => ({
  ...(await original()),
  useDebouncedValue: (<T,>(value: T) => value) as never,
}));

vi.mock(import("../../state/promptCost"), () => ({
  usePromptCostAssessment: (params: {
    readonly environmentId: EnvironmentId | null;
    readonly input: PromptCostInput | null;
  }) => {
    hookMocks.lastInput = params.input;
    return {
      assessment: params.input === null ? null : hookMocks.assessment,
      isPending: false,
      error: null,
    };
  },
}));

const { useComposerPromptCost } = await import("./useComposerPromptCost");

const ENV_A = EnvironmentId.make("env-a");
const ENV_B = EnvironmentId.make("env-b");
const THREAD_A = ThreadId.make("thread-a");
const THREAD_B = ThreadId.make("thread-b");
const CLAUDE_ID = ProviderInstanceId.make("claudeAgent");
const CODEX_ID = ProviderInstanceId.make("codex");

function makeAssessment(overrides: Partial<PromptCostAssessment> = {}): PromptCostAssessment {
  return {
    inputTokens: { context: 24_000, prompt: 350, attachments: 1_200, output: 900 },
    estimate: { medianUsd: 0.42, p90Usd: 0.85 },
    confidence: "high",
    basis: ["ownThread", "projectSimilar", "rates"],
    classifier: {
      complexity: "simple",
      reason: "single-file rename",
      model: "claude-haiku-4-5",
      cached: true,
    },
    alternatives: [
      {
        instanceId: CLAUDE_ID,
        model: "claude-haiku-4-5",
        label: "Claude Haiku 4.5",
        estimate: { medianUsd: 0.12, p90Usd: 0.25 },
        saveRatio: 0.71,
        verdict: "sameFit",
        evidence: { similarRuns: 3, successRate: 2 / 3, medianCostUsd: 0.31 },
      },
      {
        instanceId: CODEX_ID,
        model: "gpt-5-mini",
        label: "GPT-5 Mini",
        estimate: { medianUsd: 0.15, p90Usd: 0.3 },
        saveRatio: 0.64,
        verdict: "untested",
        evidence: { similarRuns: 0, successRate: 0, medianCostUsd: 0 },
      },
      {
        instanceId: CODEX_ID,
        model: "gpt-5-nano",
        label: "GPT-5 Nano",
        estimate: { medianUsd: 0.05, p90Usd: 0.11 },
        saveRatio: 0.88,
        verdict: "risky",
        evidence: { similarRuns: 4, successRate: 0.25, medianCostUsd: 0.05 },
      },
      {
        instanceId: CLAUDE_ID,
        model: "claude-sonnet-4-6",
        label: "Fourth Hidden Model",
        estimate: { medianUsd: 0.2, p90Usd: 0.4 },
        saveRatio: 0.52,
        verdict: "sameFit",
        evidence: { similarRuns: 2, successRate: 1, medianCostUsd: 0.2 },
      },
    ],
    recommendation: {
      instanceId: CLAUDE_ID,
      model: "claude-haiku-4-5",
      label: "Claude Haiku 4.5",
      estimate: { medianUsd: 0.12, p90Usd: 0.25 },
      saveRatio: 0.71,
      verdict: "sameFit",
      evidence: { similarRuns: 3, successRate: 2 / 3, medianCostUsd: 0.31 },
    },
    priced: true,
    note: null,
    ...overrides,
  };
}

function makeProps(overrides: Partial<ComposerPromptCostProps> = {}): ComposerPromptCostProps {
  return {
    state: "recommendation",
    assessment: makeAssessment(),
    isPending: false,
    error: null,
    mode: "suggest",
    size: "sm",
    switchedFrom: null,
    onSelectAlternative: vi.fn(),
    onRevertModel: vi.fn(),
    onModeChange: vi.fn(),
    ...overrides,
  };
}

describe("ComposerPromptCost", () => {
  it("renders nothing when hidden and renders loading, priced, unpriced, and error chip states", async () => {
    await using screen = await render(<ComposerPromptCost {...makeProps({ state: "hidden" })} />);
    expect(screen.container.textContent).toBe("");

    await screen.rerender(
      <ComposerPromptCost
        {...makeProps({ state: "loading", assessment: null, isPending: true })}
      />,
    );
    await expect
      .element(screen.getByRole("button", { name: "Estimating prompt cost" }))
      .toBeVisible();

    await screen.rerender(
      <ComposerPromptCost
        {...makeProps({
          state: "priced",
          assessment: makeAssessment({ recommendation: null, alternatives: [] }),
        })}
      />,
    );
    const pricedTrigger = screen.getByRole("button", {
      name: "Predicted prompt cost about $0.42",
    });
    await expect.element(pricedTrigger).toBeVisible();
    await expect.element(pricedTrigger).toHaveTextContent("≈ $0.42");

    await screen.rerender(
      <ComposerPromptCost
        {...makeProps({
          state: "unpriced",
          assessment: makeAssessment({ priced: false, recommendation: null, note: "noPrice" }),
        })}
      />,
    );
    const unpricedTrigger = screen.getByRole("button", {
      name: "Prompt cost unavailable: no price for this model",
    });
    await expect.element(unpricedTrigger).toBeVisible();
    await userEvent.click(unpricedTrigger);
    await expect
      .element(page.getByText("No price for this model. Add one in Usage."))
      .toBeVisible();
    await expect.element(page.getByText("No price for this model.")).not.toBeInTheDocument();

    await screen.rerender(
      <ComposerPromptCost
        {...makeProps({
          state: "error",
          assessment: null,
          error: "Estimator offline",
        })}
      />,
    );
    await expect.element(page.getByText("Estimator offline")).toBeVisible();
  });

  it("maps classifierUnavailable note and omits colon when classifier reason is blank", async () => {
    await using screen = await render(
      <ComposerPromptCost
        {...makeProps({
          state: "priced",
          assessment: makeAssessment({
            recommendation: null,
            alternatives: [],
            note: "classifierUnavailable",
            classifier: {
              complexity: "moderate",
              reason: "   ",
              model: "claude-haiku-4-5",
              cached: false,
            },
          }),
        })}
      />,
    );

    await userEvent.click(screen.getByRole("button"));
    await expect.element(page.getByText("Looks moderate", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Classifier unavailable.")).toBeVisible();
  });

  it("opens the popup with details, caps alternatives to 3, and selects an alternative on Use click", async () => {
    const onSelectAlternative = vi.fn();
    await using screen = await render(
      <ComposerPromptCost {...makeProps({ onSelectAlternative })} />,
    );

    const trigger = screen.getByRole("button", {
      name: "Predicted prompt cost about $0.42; Claude Haiku 4.5 could save 71%",
    });
    await expect.element(trigger).toHaveTextContent("≈ $0.42 −71%");

    await userEvent.click(trigger);

    await expect.element(page.getByText("Predicted cost ≈ $0.42–$0.85 (median–p90)")).toBeVisible();
    await expect.element(page.getByText("Looks simple: single-file rename")).toBeVisible();
    await expect.element(page.getByText("cached")).toBeVisible();
    await expect
      .element(page.getByText("own thread history, similar tasks in this project, list prices"))
      .toBeVisible();
    await expect.element(page.getByText("3 similar tasks, 2 finished, median $0.31")).toBeVisible();
    await expect.element(page.getByText("Fourth Hidden Model")).not.toBeInTheDocument();

    await userEvent.click(page.getByRole("button", { name: "Use Claude Haiku 4.5" }));
    expect(onSelectAlternative).toHaveBeenCalledWith(CLAUDE_ID, "claude-haiku-4-5");
  });

  it("switches modes in the footer and offers Back to previous model when switched", async () => {
    const onModeChange = vi.fn();
    const onRevertModel = vi.fn();
    await using screen = await render(
      <ComposerPromptCost
        {...makeProps({
          mode: "suggest",
          switchedFrom: {
            instanceId: CLAUDE_ID,
            model: "claude-opus-4-6",
            label: "Claude Opus 4.6",
          },
          onModeChange,
          onRevertModel,
        })}
      />,
    );

    await userEvent.click(screen.getByRole("button"));

    await userEvent.click(page.getByRole("button", { name: "Auto" }));
    expect(onModeChange).toHaveBeenCalledWith("auto");

    await userEvent.click(page.getByRole("button", { name: "Back to Claude Opus 4.6" }));
    expect(onRevertModel).toHaveBeenCalledTimes(1);
  });
});

describe("useComposerPromptCost", () => {
  function resetHookMocks() {
    hookMocks.supportsPromptCost = true;
    hookMocks.canUseClassifier = true;
    hookMocks.assessment = null;
    hookMocks.lastInput = null;
  }

  interface HarnessProps {
    readonly environmentId?: EnvironmentId;
    readonly threadId?: ThreadId | null;
    readonly prompt?: string;
    readonly settings?: UnifiedSettings;
    readonly initialModel?: string;
    readonly rejectSelection?: boolean;
    readonly onSelectSpy?: (
      instanceId: ProviderInstanceId,
      model: string,
      options?: { focusComposer?: boolean },
    ) => void;
    readonly onSwitchedFromSeen?: (value: ComposerPromptCostSwitchedFrom | null) => void;
  }

  function HookHarness(props: HarnessProps) {
    const [selectedModel, setSelectedModel] = useState(props.initialModel ?? "claude-opus-4-6");
    const result = useComposerPromptCost({
      environmentId: props.environmentId ?? ENV_A,
      threadId: props.threadId === undefined ? THREAD_A : props.threadId,
      prompt: props.prompt ?? "refactor the authentication middleware cleanly",
      composerFiles: [],
      composerImages: [],
      selectedInstanceId: CLAUDE_ID,
      selectedModel,
      selectedModelLabel: selectedModel,
      lockedProvider: null,
      multipleModelSelections: null,
      compactFirst: false,
      settings: props.settings ?? { ...DEFAULT_UNIFIED_SETTINGS, promptCostEstimate: "auto" },
      onProviderModelSelect: (instanceId, model, options) => {
        props.onSelectSpy?.(instanceId, model, options);
        if (!props.rejectSelection) {
          setSelectedModel(model);
        }
      },
    });
    props.onSwitchedFromSeen?.(result.switchedFrom);
    return (
      <div>
        <span data-testid="model">{selectedModel}</span>
        <span data-testid="switched-from">{result.switchedFrom?.model ?? "none"}</span>
        <button type="button" onClick={() => setSelectedModel("claude-sonnet-4-6")}>
          Manual Sonnet
        </button>
        <button type="button" onClick={() => result.revertModel()}>
          Revert
        </button>
      </div>
    );
  }

  it("auto-switches with focusComposer: false, keeps switchedFrom referentially stable, and clears it when thread or environment changes", async () => {
    resetHookMocks();
    hookMocks.assessment = makeAssessment();
    const onSelectSpy = vi.fn();
    const seenSwitchedFrom: Array<ComposerPromptCostSwitchedFrom | null> = [];

    await using screen = await render(
      <HookHarness
        onSelectSpy={onSelectSpy}
        onSwitchedFromSeen={(value) => {
          if (value !== null) seenSwitchedFrom.push(value);
        }}
      />,
    );

    await expect.element(screen.getByTestId("model")).toHaveTextContent("claude-haiku-4-5");
    await expect.element(screen.getByTestId("switched-from")).toHaveTextContent("claude-opus-4-6");
    expect(onSelectSpy).toHaveBeenCalledWith(CLAUDE_ID, "claude-haiku-4-5", {
      focusComposer: false,
    });

    const firstRef = seenSwitchedFrom[0];
    expect(firstRef).toBeDefined();
    await screen.rerender(
      <HookHarness
        prompt="refactor the authentication middleware cleanly!"
        onSelectSpy={onSelectSpy}
        onSwitchedFromSeen={(value) => {
          if (value !== null) seenSwitchedFrom.push(value);
        }}
      />,
    );
    expect(seenSwitchedFrom.at(-1)).toBe(firstRef);

    // Switching thread clears switchedFrom.
    await screen.rerender(<HookHarness threadId={THREAD_B} onSelectSpy={onSelectSpy} />);
    await expect.element(screen.getByTestId("switched-from")).toHaveTextContent("none");

    // Auto-switch again on a fresh prompt, then switching environment clears switchedFrom.
    await screen.rerender(
      <HookHarness
        environmentId={ENV_A}
        threadId={THREAD_B}
        prompt="completely different task prompt for env switch test"
        onSelectSpy={onSelectSpy}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Manual Sonnet" }));
    hookMocks.assessment = makeAssessment();
    await screen.rerender(
      <HookHarness
        environmentId={ENV_A}
        threadId={THREAD_B}
        prompt="another brand new prompt that triggers auto switch"
        onSelectSpy={onSelectSpy}
      />,
    );
    await expect
      .element(screen.getByTestId("switched-from"))
      .toHaveTextContent("claude-sonnet-4-6");

    await screen.rerender(
      <HookHarness
        environmentId={ENV_B}
        threadId={THREAD_B}
        prompt="another brand new prompt that triggers auto switch"
        onSelectSpy={onSelectSpy}
      />,
    );
    await expect.element(screen.getByTestId("switched-from")).toHaveTextContent("none");
  });

  it("does not override a manual model pick when a late assessment arrives", async () => {
    resetHookMocks();
    const onSelectSpy = vi.fn();
    await using screen = await render(<HookHarness onSelectSpy={onSelectSpy} />);
    await expect.element(screen.getByTestId("model")).toHaveTextContent("claude-opus-4-6");

    // User manually selects Sonnet before assessment arrives.
    await userEvent.click(screen.getByRole("button", { name: "Manual Sonnet" }));
    await expect.element(screen.getByTestId("model")).toHaveTextContent("claude-sonnet-4-6");

    // Late assessment arrives recommending Haiku; manual selection must win for this prompt.
    hookMocks.assessment = makeAssessment();
    await screen.rerender(<HookHarness onSelectSpy={onSelectSpy} />);
    await expect.element(screen.getByTestId("model")).toHaveTextContent("claude-sonnet-4-6");
    expect(onSelectSpy).not.toHaveBeenCalled();

    // Changing the prompt produces a new hash, allowing auto-switch again.
    await screen.rerender(
      <HookHarness
        prompt="a different prompt that has not been manually overridden"
        onSelectSpy={onSelectSpy}
      />,
    );
    await expect.element(screen.getByTestId("model")).toHaveTextContent("claude-haiku-4-5");
    expect(onSelectSpy).toHaveBeenCalledTimes(1);
  });

  it("clears switchedFrom and does not mark prompt applied when switch target is rejected", async () => {
    resetHookMocks();
    hookMocks.assessment = makeAssessment();
    const onSelectSpy = vi.fn();
    await using screen = await render(<HookHarness rejectSelection onSelectSpy={onSelectSpy} />);
    await expect.element(screen.getByTestId("model")).toHaveTextContent("claude-opus-4-6");
    await expect.element(screen.getByTestId("switched-from")).toHaveTextContent("none");
    expect(onSelectSpy).toHaveBeenCalledTimes(1);

    // Once target is accepted and a fresh assessment arrives, auto-switch can still apply.
    hookMocks.assessment = makeAssessment();
    await screen.rerender(<HookHarness rejectSelection={false} onSelectSpy={onSelectSpy} />);
    await expect.element(screen.getByTestId("model")).toHaveTextContent("claude-haiku-4-5");
    await expect.element(screen.getByTestId("switched-from")).toHaveTextContent("claude-opus-4-6");
  });

  it("forces useClassifier to false when operate permission is denied", async () => {
    resetHookMocks();
    hookMocks.canUseClassifier = false;
    await using deniedScreen = await render(
      <HookHarness
        settings={{
          ...DEFAULT_UNIFIED_SETTINGS,
          promptCostEstimate: "auto",
          promptCostClassifier: { instanceId: CLAUDE_ID, model: "claude-haiku-4-5" },
        }}
      />,
    );
    expect(hookMocks.lastInput?.useClassifier).toBe(false);
    await deniedScreen.unmount();

    hookMocks.canUseClassifier = true;
    await using grantedScreen = await render(
      <HookHarness
        environmentId={ENV_B}
        settings={{
          ...DEFAULT_UNIFIED_SETTINGS,
          promptCostEstimate: "auto",
          promptCostClassifier: { instanceId: CLAUDE_ID, model: "claude-haiku-4-5" },
        }}
      />,
    );
    expect(grantedScreen.getByTestId("model")).toBeTruthy();
    expect(hookMocks.lastInput?.useClassifier).toBe(true);
  });
});
