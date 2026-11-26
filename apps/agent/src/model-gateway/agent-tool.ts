import { asSchema, jsonSchema, tool } from "ai";
import type { FlexibleSchema, JSONSchema7, Tool } from "ai";
import { Data, Effect, Option, Result, Schema } from "effect";

import type { ApprovalRunOutcome } from "../approval/approval-answering.ts";
import { approvalSummaryOf } from "../approval/approval-summary.ts";
import type {
  ApprovalSummaryOf,
  InputApprovalSummary,
} from "../approval/approval-summary.ts";
import { riskClassified } from "../approval/risk-class.ts";
import type {
  InputRiskClass,
  RiskClass,
  RiskClassified,
} from "../approval/risk-class.ts";
import { blockedCallReason } from "../approval/tool-gate.ts";
import type { GateDecision, GatedTool } from "../approval/tool-gate.ts";

export class ToolFailed extends Data.TaggedError("ToolFailed")<{
  readonly message: string;
}> {}

export const unexpectedToolFailureMessage = "The tool failed unexpectedly";

export type RunToolEffect = <Output>(
  effect: Effect.Effect<Output, ToolFailed>
) => Promise<Output>;

export type ToolInputGate = (input: unknown) => GateDecision;

export type InputJsonSchema = () => JSONSchema7 | PromiseLike<JSONSchema7>;

export interface AgentTool extends GatedTool {
  readonly description: string;
  readonly inputJsonSchema: InputJsonSchema;
  readonly approvalSummaryOf: ApprovalSummaryOf;
  readonly approvalExpiryMillis?: number;
  readonly hasExternalEffect?: true;
  readonly approvedRunOutcomeOf?: (output: unknown) => ApprovalRunOutcome;
  readonly executeApproved: (
    frozenInput: unknown,
    toolCallId: string
  ) => Effect.Effect<unknown, ToolFailed>;
  readonly toAiSdkTool: (runEffect: RunToolEffect, gate: ToolInputGate) => Tool;
}

export type AgentTools = Readonly<Record<string, AgentTool>>;

export const effectInputSchema = <Input>(
  schema: Schema.Codec<Input, unknown>
): FlexibleSchema<Input> =>
  jsonSchema<Input>(Schema.toJsonSchemaDocument(schema).schema as JSONSchema7, {
    validate: (value) =>
      Result.match(Schema.decodeUnknownResult(schema)(value), {
        onSuccess: (decoded) => ({ success: true, value: decoded }),
        onFailure: (issue) => ({
          success: false,
          error: new Error(String(issue)),
        }),
      }),
  });

export interface InputCheck<Input> {
  readonly isInput: (value: unknown) => value is Input;
  readonly holds: (input: Input) => boolean;
}

const inputCheckOf =
  <Input>(check: InputCheck<Input> | undefined) =>
  (input: unknown) =>
    check !== undefined && check.isInput(input) && check.holds(input);

export const noTools: AgentTools = {};

export const toolNamed = (
  tools: AgentTools,
  name: string
): AgentTool | undefined =>
  Object.hasOwn(tools, name) ? tools[name] : undefined;

export type ToolApproval<Input> =
  | {
      readonly riskClass: "read";
      readonly riskClassOfInput?: undefined;
      readonly approvalSummary?: undefined;
      readonly approvalExpiryMillis?: undefined;
    }
  | {
      readonly riskClass: RiskClass;
      readonly riskClassOfInput?: InputRiskClass<Input>;
      readonly approvalSummary: InputApprovalSummary<Input>;
      readonly approvalExpiryMillis?: number;
    };

export interface ToolCall {
  readonly toolCallId: string;
  readonly modelStepKey: number;
  readonly markedUntrusted: boolean;
}

type AgentToolDefinition<Input, Output> = ToolApproval<Input> & {
  readonly description: string;
  readonly inputSchema: FlexibleSchema<Input>;
  readonly marksItsWorkUntrusted?: InputCheck<Input>;
  readonly codeWrittenInput?: (input: Input) => Input;
  readonly hasExternalEffect?: true;
  readonly approvedRunOutcomeOf?: (output: Output) => ApprovalRunOutcome;
  readonly execute: (
    input: Input,
    call: ToolCall
  ) => Effect.Effect<Output, ToolFailed>;
};

const anyInputWithSchemaOf = <Input>(
  schema: FlexibleSchema<Input>
): FlexibleSchema<Input> =>
  jsonSchema<Input>(() => asSchema(schema).jsonSchema);

const blockedAiSdkTool = <Input>(
  definition: Pick<
    AgentToolDefinition<Input, unknown>,
    "description" | "inputSchema"
  >,
  runEffect: RunToolEffect
): Tool =>
  tool<Input, unknown, Record<string, unknown>>({
    description: definition.description,
    inputSchema: anyInputWithSchemaOf(definition.inputSchema),
    execute: () =>
      runEffect(Effect.fail(new ToolFailed({ message: blockedCallReason }))),
  });

export const frozenInputMismatchMessage =
  "The approved input no longer matches the input of this tool";

const validatedInput = <Input>(schema: FlexibleSchema<Input>, input: unknown) =>
  Effect.tryPromise({
    try: () => Promise.resolve(asSchema(schema).validate?.(input)),
    catch: () => new ToolFailed({ message: frozenInputMismatchMessage }),
  }).pipe(
    Effect.flatMap((validation) =>
      validation?.success === true
        ? Effect.succeed(validation.value)
        : Effect.fail(new ToolFailed({ message: frozenInputMismatchMessage }))
    )
  );

const executeApprovedOf =
  <Input, Output>(
    definition: AgentToolDefinition<Input, Output>,
    { riskClassOf }: RiskClassified
  ) =>
  (frozenInput: unknown, toolCallId: string) =>
    riskClassOf(frozenInput) === "blocked"
      ? Effect.fail(new ToolFailed({ message: blockedCallReason }))
      : validatedInput(definition.inputSchema, frozenInput).pipe(
          Effect.flatMap((input) =>
            definition.execute(input, {
              toolCallId,
              modelStepKey: 0,
              markedUntrusted: false,
            })
          )
        );

const inputToRun = <Input>(
  codeWrittenInput: ((input: Input) => Input) | undefined,
  gate: ToolInputGate,
  input: Input
): Input =>
  codeWrittenInput !== undefined && gate(input)._tag === "RunCodeWrittenInput"
    ? codeWrittenInput(input)
    : input;

export const agentTool = <Input, Output>(
  definition: AgentToolDefinition<Input, Output>
): AgentTool => {
  const classified = riskClassified(
    definition.riskClass,
    definition.riskClassOfInput
  );
  return {
    description: definition.description,
    inputJsonSchema: () => asSchema(definition.inputSchema).jsonSchema,
    executeApproved: executeApprovedOf(definition, classified),
    ...classified,
    marksItsWorkUntrusted: inputCheckOf(definition.marksItsWorkUntrusted),
    hasCodeWrittenInput: definition.codeWrittenInput !== undefined,
    ...(definition.hasExternalEffect === true
      ? { hasExternalEffect: true as const }
      : {}),
    ...(definition.approvedRunOutcomeOf === undefined
      ? {}
      : {
          approvedRunOutcomeOf: (output: unknown) =>
            definition.approvedRunOutcomeOf?.(output as Output) ?? {
              result: "executed" as const,
              output,
            },
        }),
    approvalSummaryOf: approvalSummaryOf(definition.approvalSummary),
    ...(definition.approvalExpiryMillis === undefined
      ? {}
      : { approvalExpiryMillis: definition.approvalExpiryMillis }),
    toAiSdkTool: (runEffect, gate) =>
      definition.riskClass === "blocked"
        ? blockedAiSdkTool(definition, runEffect)
        : tool<Input, unknown, Record<string, unknown>>({
            description: definition.description,
            inputSchema: definition.inputSchema,
            execute: (input: Input, { toolCallId, messages }) =>
              runEffect(
                definition.execute(
                  inputToRun(definition.codeWrittenInput, gate, input),
                  {
                    toolCallId,
                    modelStepKey: messages.length,
                    markedUntrusted: gate(input)._tag === "RunMarkedUntrusted",
                  }
                )
              ),
          }),
  };
};

export const runToolEffect =
  (
    runPromise: <Output>(effect: Effect.Effect<Output>) => Promise<Output>
  ): RunToolEffect =>
  async (effect) => {
    const outcome = await runPromise(
      effect.pipe(
        Effect.map((value) => ({ _tag: "Succeeded", value }) as const),
        Effect.catchTag("ToolFailed", (failure) =>
          Effect.succeed({ _tag: "Failed", message: failure.message } as const)
        ),
        Effect.catchCause(() =>
          Effect.succeed({
            _tag: "Failed",
            message: unexpectedToolFailureMessage,
          } as const)
        )
      )
    );
    if (outcome._tag === "Failed") {
      throw new Error(outcome.message);
    }
    return outcome.value;
  };

export const outcomeToolRunMessage =
  "An outcome tool does nothing by itself, so code cannot run it";

interface OutcomeToolDefinition<Input> {
  readonly description: string;
  readonly inputSchema: FlexibleSchema<Input>;
}

export const outcomeTool = <Input>(
  definition: OutcomeToolDefinition<Input>
): AgentTool => ({
  description: definition.description,
  inputJsonSchema: () => asSchema(definition.inputSchema).jsonSchema,
  ...riskClassified("read"),
  marksItsWorkUntrusted: () => false,
  hasCodeWrittenInput: false,
  approvalSummaryOf: () => Effect.succeed(Option.none()),
  executeApproved: () =>
    Effect.fail(new ToolFailed({ message: outcomeToolRunMessage })),
  toAiSdkTool: () =>
    tool<Input, unknown, Record<string, unknown>>({
      description: definition.description,
      inputSchema: definition.inputSchema,
      outputSchema: jsonSchema<unknown>({}),
    }),
});
