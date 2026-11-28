import { Schema } from "effect";

import { mcpCallStatuses } from "../personal-agent/storage-values.ts";

export const McpCallOutputSchema = Schema.Struct({
  connection: Schema.String,
  tool: Schema.String,
  status: Schema.Literals(mcpCallStatuses),
  result: Schema.optionalKey(Schema.String),
  truncated: Schema.optionalKey(Schema.Literal(true)),
  notice: Schema.optionalKey(Schema.String),
  resultCount: Schema.optionalKey(Schema.Int),
  omittedIds: Schema.optionalKey(Schema.Int),
  resultIds: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        position: Schema.Int,
        id: Schema.Union([Schema.String, Schema.Number]),
      })
    )
  ),
});

export type McpCallOutput = typeof McpCallOutputSchema.Type;

export const truncatedNotice = (limit: number) =>
  `[truncated: the result was cut at ${limit} characters]`;
