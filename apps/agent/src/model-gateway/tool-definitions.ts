import { Effect, Schema } from "effect";

import type { AgentTools } from "./agent-tool.ts";

export const ToolDefinitionSchema = Schema.Struct({
  type: Schema.Literal("function"),
  name: Schema.String,
  description: Schema.String,
  inputSchema: Schema.Record(Schema.String, Schema.Unknown),
});

export type ToolDefinition = typeof ToolDefinitionSchema.Type;

export const ToolDefinitionsJsonSchema = Schema.fromJsonString(
  Schema.Array(ToolDefinitionSchema)
);

export const toolDefinitionsOf = (tools: AgentTools) =>
  Effect.promise(() =>
    Promise.all(
      Object.entries(tools).map(
        async ([name, agentTool]): Promise<ToolDefinition> => ({
          type: "function",
          name,
          description: agentTool.description,
          inputSchema: { ...(await agentTool.inputJsonSchema()) },
        })
      )
    )
  );
