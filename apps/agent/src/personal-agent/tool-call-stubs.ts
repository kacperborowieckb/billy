import type { ToolCallPart, ToolResultPart } from "ai";
import { Effect, Option, Schema } from "effect";

import { McpCallOutputSchema } from "../mcp/mcp-call-output.ts";
import type { McpCallOutput } from "../mcp/mcp-call-output.ts";
import { mcpCatalogToolOf, mcpEntryOf } from "../mcp/mcp-catalog.ts";
import type { McpCatalog } from "../mcp/mcp-catalog.ts";
import {
  callMcpToolToolName,
  findMcpToolsToolName,
} from "../mcp/mcp-tool-names.ts";
import { sha256Hex } from "../sha256-hex.ts";
import { noteIdsOf, storedToolNameOf, toolCallStatusOf } from "./tool-steps.ts";
import type { ToolOutput } from "./tool-steps.ts";

export const removedInputStub = {
  removed: "[Input removed from the history]",
};

export interface StubSource {
  readonly turnEventId: string;
  readonly mcpCatalog: McpCatalog;
}

interface StubbedCall {
  readonly call: Pick<ToolCallPart, "toolName" | "input">;
  readonly output: ToolOutput | undefined;
}

const McpTargetSchema = Schema.Struct({
  connection: Schema.String,
  tool: Schema.optionalKey(Schema.String),
});

const decodeMcpTarget = Schema.decodeUnknownOption(McpTargetSchema);
const decodeMcpCallOutput = Schema.decodeUnknownOption(McpCallOutputSchema);
const decodeMatchCount = Schema.decodeUnknownOption(
  Schema.Struct({ matchCount: Schema.Int })
);

const jsonValueOf = (output: ToolOutput | undefined) =>
  output?.type === "json" ? output.value : undefined;

const mcpToolNames: ReadonlySet<string> = new Set([
  callMcpToolToolName,
  findMcpToolsToolName,
]);

const mcpTargetText = (input: unknown, catalog: McpCatalog) =>
  decodeMcpTarget(input).pipe(
    Option.flatMap(({ connection, tool }) => {
      const entry = mcpEntryOf(catalog, connection);
      if (entry === undefined) {
        return Option.none<string>();
      }
      if (tool === undefined) {
        return Option.some(`connection ${entry.catalogId}`);
      }
      const listed = mcpCatalogToolOf(entry, tool);
      return Option.some(
        `connection ${entry.catalogId}, ${listed === undefined ? "a tool that the catalog does not list" : `tool ${listed.name}`}`
      );
    })
  );

const subjectOf = (
  { toolName, input }: StubbedCall["call"],
  catalog: McpCatalog
) => {
  const name = storedToolNameOf(toolName);
  return mcpToolNames.has(toolName)
    ? mcpTargetText(input, catalog).pipe(
        Option.map((target) => `${name} on ${target}`),
        Option.getOrElse(() => name)
      )
    : name;
};

const mcpStatusTexts: Readonly<Record<McpCallOutput["status"], string>> = {
  done: "done",
  failed: "failed",
  timed_out: "timed out",
};

const statusOf = (output: ToolOutput | undefined) =>
  decodeMcpCallOutput(jsonValueOf(output)).pipe(
    Option.map(({ status }) => mcpStatusTexts[status]),
    Option.getOrElse(() => toolCallStatusOf(output))
  );

const failedStatuses: ReadonlySet<string> = new Set([
  "failed",
  "timed out",
  "no result",
]);

const counted = (count: number, one: string) =>
  ` ${count} ${count === 1 ? one : `${one}s`}.`;

const mcpResultText = ({
  resultCount,
  resultIds,
  omittedIds,
}: McpCallOutput) => {
  const countText =
    resultCount === undefined ? "" : counted(resultCount, "result");
  const idsText =
    resultIds === undefined || resultIds.length === 0
      ? ""
      : ` Ids: ${resultIds.map(({ position, id }) => `${position}: ${id}`).join(", ")}.`;
  const omittedText =
    omittedIds === undefined ? "" : ` ${omittedIds} more ids not kept.`;
  return `${countText}${idsText}${omittedText}`;
};

const noteIdsText = (output: ToolOutput | undefined) => {
  const ids = noteIdsOf(output);
  return ids.length === 0 ? "" : ` Note ids: ${ids.join(", ")}.`;
};

const factsOf = ({ call, output }: StubbedCall) => {
  const value = jsonValueOf(output);
  if (call.toolName === callMcpToolToolName) {
    return decodeMcpCallOutput(value).pipe(
      Option.map(mcpResultText),
      Option.getOrElse(() => "")
    );
  }
  if (call.toolName === findMcpToolsToolName) {
    return decodeMatchCount(value).pipe(
      Option.map(({ matchCount }) => counted(matchCount, "matching tool")),
      Option.getOrElse(() => "")
    );
  }
  return noteIdsText(output);
};

interface ResultStub extends StubbedCall {
  readonly removed: string;
  readonly source: StubSource;
}

export const resultStubOf = ({
  removed,
  call,
  output,
  source,
}: ResultStub): ToolResultPart["output"] => {
  const status = statusOf(output);
  return {
    type: failedStatuses.has(status) ? "error-text" : "text",
    value: `[${removed} removed from the history. ${subjectOf(call, source.mcpCatalog)}: ${status}.${factsOf({ call, output })} Full record: Trace of Turn ${source.turnEventId}. When you need the data, call a tool that reads it yourself, and do not ask the Owner for data that a tool can read. Never repeat a change because of this note]`,
  };
};

export const storedCallIdOf = (turnEventId: string, toolCallId: string) =>
  sha256Hex(`${turnEventId}\n${toolCallId}`).pipe(
    Effect.map((hash) => `call_${hash.slice(0, 24)}`)
  );
