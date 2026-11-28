import { asSchema, jsonSchema, tool } from "ai";
import type { FlexibleSchema } from "ai";
import { Effect, Option } from "effect";

import { riskClassified } from "../approval/risk-class.ts";
import { ToolFailed } from "./agent-tool.ts";
import type { AgentTool } from "./agent-tool.ts";

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
