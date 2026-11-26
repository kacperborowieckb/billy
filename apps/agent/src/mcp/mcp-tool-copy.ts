import { Schema } from "effect";

export const McpToolCopySchema = Schema.Struct({
  name: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  description: Schema.String,
  inputSchema: Schema.Record(Schema.String, Schema.Unknown),
  annotations: Schema.Struct({
    destructiveHint: Schema.optionalKey(Schema.Boolean),
    readOnlyHint: Schema.optionalKey(Schema.Boolean),
  }),
});

export type McpToolCopy = typeof McpToolCopySchema.Type;

export const McpToolCatalogCopySchema = Schema.Array(McpToolCopySchema);
