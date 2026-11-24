import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import { FeedbackInput } from "../feedback/FeedbackReport.ts";
import { authLocationFlags, projectLocationFlags } from "./config.ts";
import { jsonFlag } from "./thread.ts";

const FEEDBACK_DISABLED_MESSAGE = "Feedback reporting is permanently disabled in V3 Code.";

class FeedbackDisabledError extends Schema.TaggedError<FeedbackDisabledError>()(
  "FeedbackDisabledError",
  {
    detail: Schema.String,
  },
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return this.detail;
  }
}

const rejectFeedback = () =>
  Console.error(FEEDBACK_DISABLED_MESSAGE).pipe(
    Effect.andThen(Effect.fail(new FeedbackDisabledError({ detail: FEEDBACK_DISABLED_MESSAGE }))),
  );

const feedbackListCommand = Command.make("list", { ...authLocationFlags, json: jsonFlag }).pipe(
  Command.withDescription("Feedback reporting is permanently disabled in V3 Code."),
  Command.withHandler(rejectFeedback),
);

export const feedbackCommand = Command.make("feedback", {
  ...projectLocationFlags,
  kind: Flag.Literals("kind", FeedbackInput.fields.kind.literals).pipe(
    Flag.withDescription("What went wrong."),
  ),
  subject: Flag.String("subject").pipe(Flag.withDescription("The tool name or command.")),
  expected: Flag.String("expected").pipe(Flag.withDescription("What you expected.")),
  actual: Flag.String("actual").pipe(Flag.withDescription("What happened instead.")),
  workaround: Flag.String("workaround").pipe(
    Flag.withDescription("What you did instead."),
    Flag.withDefault(""),
  ),
}).pipe(
  Command.withDescription("Feedback reporting is permanently disabled in V3 Code."),
  Command.withHandler(rejectFeedback),
  Command.withSubcommands([feedbackListCommand]),
);
