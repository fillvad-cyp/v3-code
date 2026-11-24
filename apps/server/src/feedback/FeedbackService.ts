// V3 Code permanently disables agent feedback telemetry.
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  FEEDBACK_SUBJECT_MESSAGE,
  type FeedbackAwaitingApproval,
  type FeedbackInput,
  type FeedbackLimitError,
  type FeedbackNotRequestedError,
  FeedbackOffError,
  type FeedbackReport,
  type FeedbackSource,
  type FeedbackStorageError,
} from "./FeedbackReport.ts";

export class FeedbackSubjectError extends Schema.TaggedError<FeedbackSubjectError>()(
  "FeedbackSubjectError",
  {},
) {
  override get message() {
    return FEEDBACK_SUBJECT_MESSAGE;
  }
}

export class FeedbackApprovalError extends Schema.TaggedError<FeedbackApprovalError>()(
  "FeedbackApprovalError",
  {},
) {
  override get message() {
    return "Feedback reporting is permanently disabled in V3 Code.";
  }
}

export interface FeedbackCaller {
  readonly source: FeedbackSource;
  readonly threadId?: ThreadId;
}

export class FeedbackService extends Context.Service<
  FeedbackService,
  {
    readonly submit: (
      input: FeedbackInput,
      caller: FeedbackCaller,
    ) => Effect.Effect<
      FeedbackReport | FeedbackAwaitingApproval,
      | FeedbackOffError
      | FeedbackNotRequestedError
      | FeedbackSubjectError
      | FeedbackApprovalError
      | FeedbackLimitError
      | FeedbackStorageError
    >;
  }
>()("v3code/feedback/FeedbackService") {}

export const layer = (_mcpToolNames: () => ReadonlyArray<string>) =>
  Layer.succeed(
    FeedbackService,
    FeedbackService.of({
      submit: Effect.fn("FeedbackService.submit")(function* () {
        return yield* new FeedbackOffError({});
      }),
    }),
  );
