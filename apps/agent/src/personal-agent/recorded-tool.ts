import type { JSONValue } from "ai";
import { Cause, Effect, Option, Schema } from "effect";

import type { RiskClass } from "../approval/risk-class.ts";
import {
  agentTool,
  effectInputSchema,
  ToolFailed,
} from "../model-gateway/agent-tool.ts";
import type {
  AgentTool,
  ToolApproval,
  ToolCall,
} from "../model-gateway/agent-tool.ts";
import type { Redactor } from "../tracing/redactor.ts";
import type { TurnProgress } from "./turn-progress.ts";

export interface RecordedToolServices {
  readonly eventId: string;
  readonly progress: TurnProgress["Service"];
  readonly redactor: Redactor["Service"];
}

export type RecordedToolApproval<Input, Output, Failure, Target> =
  | {
      readonly riskClass: "read";
      readonly riskClassOfInput?: undefined;
      readonly resolve?: undefined;
      readonly approvalSummary?: undefined;
      readonly work: (
        input: Input,
        call: Pick<ToolCall, "markedUntrusted">
      ) => Effect.Effect<Output, Failure>;
    }
  | {
      readonly riskClass: RiskClass;
      readonly riskClassOfInput?: (input: Input) => RiskClass;
      readonly resolve: (input: Input) => Effect.Effect<Target, ToolFailed>;
      readonly approvalSummary: (target: Target) => string;
      readonly work: (
        target: Target,
        call: Pick<ToolCall, "markedUntrusted">
      ) => Effect.Effect<Output, Failure>;
    };

export type RecordedToolDefinition<
  Input extends JSONValue,
  Output extends JSONValue,
  Failure,
  Target = Input,
> = RecordedToolApproval<Input, Output, Failure, Target> & {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Schema.Codec<Input, unknown>;
  readonly failureMessage: string | ((cause: Cause.Cause<unknown>) => string);
  readonly recordedInput?: (input: Input) => JSONValue;
  readonly marksItsWorkUntrusted?: (input: Input) => boolean;
  readonly codeWrittenInput?: (input: Input) => Input;
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

const approvalOf = <
  Input extends JSONValue,
  Output extends JSONValue,
  Failure,
  Target,
>(
  definition: RecordedToolApproval<Input, Output, Failure, Target> & {
    readonly inputSchema: Schema.Codec<Input, unknown>;
  }
): ToolApproval<Input> => {
  const isInput = Schema.is(definition.inputSchema);
  if (definition.approvalSummary === undefined) {
    return { riskClass: definition.riskClass };
  }
  const { resolve, approvalSummary } = definition;
  return {
    riskClass: definition.riskClass,
    ...(definition.riskClassOfInput === undefined
      ? {}
      : {
          riskClassOfInput: { isInput, of: definition.riskClassOfInput },
        }),
    approvalSummary: {
      isInput,
      of: (input) => resolve(input).pipe(Effect.map(approvalSummary)),
    },
  };
};

const workOf = <
  Input extends JSONValue,
  Output extends JSONValue,
  Failure,
  Target,
>(
  definition: RecordedToolDefinition<Input, Output, Failure, Target>,
  input: Input,
  call: Pick<ToolCall, "markedUntrusted">
) =>
  definition.resolve === undefined
    ? definition.work(input, call)
    : definition
        .resolve(input)
        .pipe(Effect.flatMap((target) => definition.work(target, call)));

export const recordedTool = <
  Input extends JSONValue,
  Output extends JSONValue,
  Failure,
  Target = Input,
>(
  { eventId, progress, redactor }: RecordedToolServices,
  definition: RecordedToolDefinition<Input, Output, Failure, Target>
): AgentTool =>
  agentTool({
    description: definition.description,
    ...approvalOf(definition),
    ...(definition.codeWrittenInput === undefined
      ? {}
      : { codeWrittenInput: definition.codeWrittenInput }),
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
      function* recordedToolEffect(
        input,
        { toolCallId, modelStepKey, markedUntrusted }
      ) {
        yield* progress.markModelStep(eventId, modelStepKey);
        const call = {
          eventId,
          toolCallId,
          toolName: definition.name,
          input: definition.recordedInput?.(input) ?? input,
          redactor,
        };
        return yield* progress
          .recordingToolCall(
            call,
            workOf(definition, input, { markedUntrusted })
          )
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
