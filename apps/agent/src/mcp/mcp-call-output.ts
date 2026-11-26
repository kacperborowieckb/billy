import { Schema } from "effect";

export const McpCallOutputSchema = Schema.Struct({
  connection: Schema.String,
  tool: Schema.String,
  status: Schema.Literals(["done", "failed", "timed_out"]),
  result: Schema.optionalKey(Schema.String),
  truncated: Schema.optionalKey(Schema.Literal(true)),
  notice: Schema.optionalKey(Schema.String),
  resultCount: Schema.optionalKey(Schema.Int),
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

const plural = (count: number) => (count === 1 ? "result" : "results");

export const mcpCallStubOf = (output: McpCallOutput) => {
  const name = `${output.connection} ${output.tool}`;
  if (output.status !== "done") {
    return `[${name}: ${output.status === "timed_out" ? "timed out" : "failed"}. Result removed from the history]`;
  }
  if (output.resultCount === undefined) {
    return `[${name}: done. Result removed from the history. Call the tool again to read it]`;
  }
  const ids = output.resultIds ?? [];
  const idsText =
    ids.length === 0
      ? ""
      : ` Ids: ${ids.map(({ position, id }) => `${position}: ${id}`).join(", ")}.`;
  return `[${name}: ${output.resultCount} ${plural(output.resultCount)}, removed from the history.${idsText} Call the tool again to read one]`;
};
