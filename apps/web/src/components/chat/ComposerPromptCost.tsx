import type {
  PromptCostAssessment,
  PromptCostBasis,
  PromptCostMode,
  PromptCostNote,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { formatTokens } from "@t3tools/shared/usageFormat";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { GaugeIcon, TrendingDownIcon, Undo2Icon } from "lucide-react";
import { memo } from "react";

import { type MessageResolver } from "../../i18n/messages";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Spinner } from "../ui/spinner";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import {
  formatCost,
  MAX_PROMPT_COST_ALTERNATIVES,
  savePercent,
  type PromptCostChipState,
} from "./promptCostChip.logic";
import { useComposerMenuState } from "./useComposerMenuState";

const BASIS_LABELS: Readonly<Record<PromptCostBasis, string>> = {
  ownThread: msg("own thread history"),
  projectSimilar: msg("similar tasks in this project"),
  globalSimilar: msg("similar tasks anywhere"),
  projectModel: msg("this model's history"),
  globalModel: msg("this model's history"),
  rates: msg("list prices"),
  compact: msg("after compaction"),
};

const CONFIDENCE_LABELS: Readonly<Record<PromptCostAssessment["confidence"], string>> = {
  high: msg("High confidence"),
  medium: msg("Medium confidence"),
  low: msg("Low confidence"),
  none: msg("No history yet"),
};

const MODE_LABELS: Readonly<Record<PromptCostMode, string>> = {
  off: msg("Off"),
  suggest: msg("Suggest"),
  auto: msg("Auto"),
};

const NOTE_LABELS: Readonly<Record<PromptCostNote, string>> = {
  noPrice: msg("No price for this model."),
  classifierUnavailable: msg("Classifier unavailable."),
};

function describeBasis(basis: ReadonlyArray<PromptCostBasis>, messages: MessageResolver): string {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const entry of basis) {
    const text = messages(BASIS_LABELS[entry]);
    if (!seen.has(text)) {
      seen.add(text);
      labels.push(text);
    }
  }
  return labels.join(", ");
}

export interface ComposerPromptCostSwitchedFrom {
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  readonly label: string;
}

export interface ComposerPromptCostProps {
  readonly state: PromptCostChipState;
  readonly assessment: PromptCostAssessment | null;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly mode: PromptCostMode;
  readonly size?: ComposerControlSize;
  readonly hidden?: boolean;
  readonly switchedFrom: ComposerPromptCostSwitchedFrom | null;
  readonly onSelectAlternative: (instanceId: ProviderInstanceId, model: string) => void;
  readonly onRevertModel: () => void;
  readonly onModeChange: (mode: PromptCostMode) => void;
}

export const ComposerPromptCost = memo(function ComposerPromptCost(props: ComposerPromptCostProps) {
  const {
    state,
    assessment,
    isPending,
    error,
    mode,
    size = "sm",
    hidden,
    switchedFrom,
    onSelectAlternative,
    onRevertModel,
    onModeChange,
  } = props;
  const gt = useGT();
  const messages = useMessages();
  const composerFloatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(hidden);

  if (state === "hidden") return null;

  const recommendation = assessment?.recommendation ?? null;
  const medianCost = assessment ? formatCost(assessment.estimate.medianUsd) : null;
  const p90Cost = assessment ? formatCost(assessment.estimate.p90Usd) : null;
  const recommendedSave = recommendation ? savePercent(recommendation.saveRatio) : 0;

  const ariaLabel = (() => {
    switch (state) {
      case "loading":
        return gt("Estimating prompt cost");
      case "unpriced":
        return gt("Prompt cost unavailable: no price for this model");
      case "error":
        return gt("Could not estimate prompt cost");
      case "recommendation":
        return gt("Predicted prompt cost about {cost}; {model} could save {percent}%", {
          cost: medianCost ?? "",
          model: recommendation?.label ?? "",
          percent: recommendedSave,
        });
      case "priced":
        return gt("Predicted prompt cost about {cost}", { cost: medianCost ?? "" });
    }
  })();

  const alternatives = (assessment?.alternatives ?? []).slice(0, MAX_PROMPT_COST_ALTERNATIVES);

  const classifierLine = (() => {
    const classifier = assessment?.classifier;
    if (!classifier) return null;
    const reason = classifier.reason.trim();
    if (reason.length === 0) {
      switch (classifier.complexity) {
        case "simple":
          return gt("Looks simple");
        case "moderate":
          return gt("Looks moderate");
        case "complex":
          return gt("Looks complex");
      }
    }
    switch (classifier.complexity) {
      case "simple":
        return gt("Looks simple: {reason}", { reason });
      case "moderate":
        return gt("Looks moderate: {reason}", { reason });
      case "complex":
        return gt("Looks complex: {reason}", { reason });
    }
  })();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <ComposerControl
            size={size}
            aria-label={ariaLabel}
            data-composer-prompt-cost="true"
            data-prompt-cost-state={state}
            className={cn(
              "shrink-0 tabular-nums",
              state === "recommendation" && "text-success-foreground hover:text-success-foreground",
            )}
          />
        }
      >
        {state === "loading" ? (
          <>
            <Spinner className="size-3" />
            <span data-composer-control-label>{gt("Estimating")}</span>
          </>
        ) : state === "unpriced" ? (
          <>
            <ComposerControlIcon icon={GaugeIcon} size={size} />
            <span data-composer-control-label>{gt("Unpriced")}</span>
          </>
        ) : state === "error" ? (
          <>
            <ComposerControlIcon icon={GaugeIcon} size={size} />
            <span data-composer-control-label>{gt("Cost unavailable")}</span>
          </>
        ) : state === "recommendation" ? (
          <>
            <ComposerControlIcon
              icon={TrendingDownIcon}
              size={size}
              className="text-success-foreground"
            />
            <span data-composer-control-label>
              ≈ {medianCost}
              {recommendedSave > 0 ? ` −${recommendedSave}%` : ""}
            </span>
          </>
        ) : (
          <>
            <ComposerControlIcon icon={GaugeIcon} size={size} />
            <span data-composer-control-label>≈ {medianCost}</span>
          </>
        )}
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="start"
        width="md"
        padding="compact"
        className="max-h-96 overflow-y-auto"
        {...composerFloatingLayerProps}
      >
        <div className="space-y-2.5 text-xs">
          {state === "loading" ? (
            <div className="flex items-center gap-2 py-1 text-muted-foreground">
              <Spinner className="size-3.5" />
              <span>
                <T>Estimating prompt cost…</T>
              </span>
            </div>
          ) : state === "error" ? (
            <p className="text-destructive-foreground">
              {error ?? gt("Could not estimate prompt cost.")}
            </p>
          ) : state === "unpriced" ? (
            <div className="space-y-1">
              <p className="font-medium text-foreground">
                <T>No price for this model. Add one in Usage.</T>
              </p>
            </div>
          ) : assessment !== null ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <p className="font-medium text-foreground tabular-nums">
                  {gt("Predicted cost ≈ {median}–{p90} (median–p90)", {
                    median: medianCost ?? "",
                    p90: p90Cost ?? "",
                  })}
                </p>
                {isPending ? <Spinner className="size-3 shrink-0" /> : null}
              </div>

              <dl className="grid grid-cols-4 gap-1.5 rounded-md bg-muted/40 px-2 py-1.5 tabular-nums">
                <div>
                  <dt className="text-muted-foreground">
                    <T>Context</T>
                  </dt>
                  <dd className="font-medium text-foreground">
                    {formatTokens(assessment.inputTokens.context)}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">
                    <T>Prompt</T>
                  </dt>
                  <dd className="font-medium text-foreground">
                    {formatTokens(assessment.inputTokens.prompt)}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">
                    <T>Files</T>
                  </dt>
                  <dd className="font-medium text-foreground">
                    {formatTokens(assessment.inputTokens.attachments)}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">
                    <T>Output</T>
                  </dt>
                  <dd className="font-medium text-foreground">
                    {formatTokens(assessment.inputTokens.output)}
                  </dd>
                </div>
              </dl>

              {assessment.classifier !== null && classifierLine !== null ? (
                <div className="space-y-1">
                  <p className="text-foreground">{classifierLine}</p>
                  <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
                    <span className="truncate font-mono text-2xs">
                      {assessment.classifier.model}
                    </span>
                    {assessment.classifier.cached ? (
                      <Badge variant="secondary" size="sm">
                        <T>cached</T>
                      </Badge>
                    ) : null}
                  </div>
                </div>
              ) : null}

              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
                <span className="font-medium text-foreground/80">
                  {messages(CONFIDENCE_LABELS[assessment.confidence])}
                </span>
                {assessment.basis.length > 0 ? (
                  <span>{describeBasis(assessment.basis, messages)}</span>
                ) : null}
              </div>

              {assessment.note !== null ? (
                <p className="text-muted-foreground">{messages(NOTE_LABELS[assessment.note])}</p>
              ) : null}

              {alternatives.length > 0 ? (
                <div className="space-y-1.5 border-t border-border/60 pt-2">
                  <p className="font-medium text-muted-foreground">
                    <T>Cheaper alternatives</T>
                  </p>
                  <ul className="space-y-1.5">
                    {alternatives.map((alternative) => {
                      const pct = savePercent(alternative.saveRatio);
                      const finished = Math.round(
                        alternative.evidence.similarRuns * alternative.evidence.successRate,
                      );
                      const evidenceText =
                        alternative.evidence.similarRuns > 0
                          ? gt(
                              "{count, plural, one {{count} similar task, {finished} finished, median {cost}} other {{count} similar tasks, {finished} finished, median {cost}}}",
                              {
                                count: alternative.evidence.similarRuns,
                                finished,
                                cost: formatCost(alternative.evidence.medianCostUsd),
                              },
                            )
                          : gt("No similar tasks yet");
                      const verdictBadge =
                        alternative.verdict === "sameFit" ? (
                          <Badge variant="success" size="sm">
                            <T>Same fit</T>
                          </Badge>
                        ) : alternative.verdict === "risky" ? (
                          <Badge variant="warning" size="sm">
                            <T>Risky</T>
                          </Badge>
                        ) : (
                          <Badge variant="secondary" size="sm">
                            <T>Untested</T>
                          </Badge>
                        );
                      return (
                        <li
                          key={`${alternative.instanceId}:${alternative.model}`}
                          className="flex items-start justify-between gap-2 rounded-md border border-border/50 px-2 py-1.5"
                        >
                          <div className="min-w-0 space-y-0.5">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="truncate font-medium text-foreground">
                                {alternative.label}
                              </span>
                              {verdictBadge}
                            </div>
                            <div className="flex flex-wrap items-center gap-1.5 tabular-nums">
                              <span className="text-foreground">
                                ≈ {formatCost(alternative.estimate.medianUsd)}
                              </span>
                              {pct > 0 ? (
                                <span className="font-medium text-success-foreground">−{pct}%</span>
                              ) : null}
                            </div>
                            <p className="text-muted-foreground">{evidenceText}</p>
                          </div>
                          <Button
                            size="xs"
                            variant="outline"
                            className="shrink-0"
                            aria-label={gt("Use {model}", { model: alternative.label })}
                            onClick={() => {
                              onSelectAlternative(alternative.instanceId, alternative.model);
                              setOpen(false);
                            }}
                          >
                            <T>Use</T>
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : null}
            </>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2">
            <ToggleGroup
              aria-label={gt("Prompt cost mode")}
              variant="segmented"
              value={[mode]}
              onValueChange={(next) => {
                const picked = next[0] as PromptCostMode | undefined;
                if (picked) onModeChange(picked);
              }}
            >
              {(["off", "suggest", "auto"] as const).map((option) => (
                <Toggle key={option} value={option}>
                  {messages(MODE_LABELS[option])}
                </Toggle>
              ))}
            </ToggleGroup>
            {switchedFrom !== null ? (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  onRevertModel();
                  setOpen(false);
                }}
              >
                <Undo2Icon className="size-3" aria-hidden="true" />
                <T>
                  Back to <Var>{switchedFrom.label}</Var>
                </T>
              </Button>
            ) : null}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
});
