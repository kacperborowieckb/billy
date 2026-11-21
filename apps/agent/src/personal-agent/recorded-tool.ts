import type { JSONValue } from "ai";
import { Cause, Effect, Option, Schema } from "effect";

import type { RiskClass } from "../approval/risk-class.ts";
import {
  agentTool,
  effectInputSchema,
  ToolFailed,
} from "../model-gateway/agent-tool.ts";
import type { AgentTool, ToolApproval } from "../model-gateway/agent-tool.ts";
import type { Redactor } from "../tracing/redactor.ts";
import type { TurnProgress } from "./turn-progress.ts";

export interface RecordedToolServices {
  readonly eventId: string;
  readonly progress: TurnProgress["Service"];
  readonly redactor: Redactor["Service"];
}

export type RecordedToolApproval<Input> =
  | {
      readonly riskClass: "read";
      readonly riskClassOfInput?: undefined;
      readonly approvalSummary?: undefined;
    }
  | {
      readonly riskClass: RiskClass;
      readonly riskClassOfInput?: (input: Input) => RiskClass;
      readonly approvalSummary: (input: Input) => Effect.Effect<string>;
    };

export type RecordedToolDefinition<
  Input extends JSONValue,
  Output extends JSONValue,
  Failure,
> = RecordedToolApproval<Input> & {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Schema.Codec<Input, unknown>;
  readonly failureMessage: string | ((cause: Cause.Cause<unknown>) => string);
  readonly recordedInput?: (input: Input) => JSONValue;
  readonly marksItsWorkUntrusted?: (input: Input) => boolean;
  readonly work: (input: Input) => Effect.Effect<Output, Failure>;
};

const toolFailedFrom =
  (failureMessage: string | ((cause: Cause.Cause<unknown>) => string)) =>
  (cause: Cause.Cause<unknown>) =>
    Cause.findErrorOption(cause).pipe(
      Option.filter((error) => error instanceof ToolFailed),
      Option.getOrElse(
        () =>
          new ToolFailed({
            message:
              typeof failureMessage === "string"
                ? failureMessage
                : failureMessage(cause),
          })
      )
    );

const approvalOf = <Input extends JSONValue>(
  definition: RecordedToolApproval<Input> & {
    readonly inputSchema: Schema.Codec<Input, unknown>;
  }
): ToolApproval<Input> => {
  const isInput = Schema.is(definition.inputSchema);
  if (definition.approvalSummary === undefined) {
    return { riskClass: definition.riskClass };
  }
  return {
    riskClass: definition.riskClass,
    ...(definition.riskClassOfInput === undefined
      ? {}
      : {
          riskClassOfInput: { isInput, of: definition.riskClassOfInput },
        }),
    approvalSummary: { isInput, of: definition.approvalSummary },
  };
};

export const recordedTool = <
  Input extends JSONValue,
  Output extends JSONValue,
  Failure,
>(
  { eventId, progress, redactor }: RecordedToolServices,
  definition: RecordedToolDefinition<Input, Output, Failure>
): AgentTool =>
  agentTool({
    description: definition.description,
    ...approvalOf(definition),
    ...(definition.marksItsWorkUntrusted === undefined
      ? {}
      : {
          marksItsWorkUntrusted: {
            isInput: Schema.is(definition.inputSchema),
            holds: definition.marksItsWorkUntrusted,
          },
        }),
    inputSchema: effectInputSchema(definition.inputSchema),
    execute: Effect.fnUntraced(
      function* recordedToolEffect(input, { toolCallId, modelStepKey }) {
        yield* progress.markModelStep(eventId, modelStepKey);
        const call = {
          eventId,
          toolCallId,
          toolName: definition.name,
          input: definition.recordedInput?.(input) ?? input,
          redactor,
        };
        return yield* progress
          .recordingToolCall(call, definition.work(input))
          .pipe(
            Effect.catchCause((cause) => {
              const failure = toolFailedFrom(definition.failureMessage)(cause);
              return progress
                .recordFailedToolCall(call, failure.message)
                .pipe(Effect.andThen(Effect.fail(failure)));
            })
          );
      },
      Effect.catchCause((cause) =>
        Effect.fail(toolFailedFrom(definition.failureMessage)(cause))
      )
    ),
  });
