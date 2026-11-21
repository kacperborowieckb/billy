import { jsonSchema, tool } from "ai";
import type { FlexibleSchema, JSONSchema7, Tool } from "ai";
import { Data, Effect, Result, Schema } from "effect";

import { riskClassified } from "../approval/risk-class.ts";
import type { RiskClass, RiskClassified } from "../approval/risk-class.ts";

export class ToolFailed extends Data.TaggedError("ToolFailed")<{
  readonly message: string;
}> {}

export const unexpectedToolFailureMessage = "The tool failed unexpectedly";

export type RunToolEffect = <Output>(
  effect: Effect.Effect<Output, ToolFailed>
) => Promise<Output>;

export interface AgentTool extends RiskClassified {
  readonly toAiSdkTool: (runEffect: RunToolEffect) => Tool;
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

export const noTools: AgentTools = {};

interface AgentToolDefinition<Input, Output> {
  readonly description: string;
  readonly inputSchema: FlexibleSchema<Input>;
  readonly riskClass: RiskClass;
  readonly riskClassOfInput?: (input: Input) => RiskClass;
  readonly execute: (
    input: Input,
    call: { readonly toolCallId: string; readonly modelStepKey: number }
  ) => Effect.Effect<Output, ToolFailed>;
}

export const agentTool = <Input, Output>(
  definition: AgentToolDefinition<Input, Output>
): AgentTool => ({
  ...riskClassified(definition.riskClass, definition.riskClassOfInput),
  toAiSdkTool: (runEffect) =>
    tool<Input, unknown, Record<string, unknown>>({
      description: definition.description,
      inputSchema: definition.inputSchema,
      execute: (input: Input, { toolCallId, messages }) =>
        runEffect(
          definition.execute(input, {
            toolCallId,
            modelStepKey: messages.length,
          })
        ),
    }),
});

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

interface OutcomeToolDefinition<Input> {
  readonly description: string;
  readonly inputSchema: FlexibleSchema<Input>;
}

export const outcomeTool = <Input>(
  definition: OutcomeToolDefinition<Input>
): AgentTool => ({
  ...riskClassified("read"),
  toAiSdkTool: () =>
    tool<Input, unknown, Record<string, unknown>>({
      description: definition.description,
      inputSchema: definition.inputSchema,
      outputSchema: jsonSchema<unknown>({}),
    }),
});
