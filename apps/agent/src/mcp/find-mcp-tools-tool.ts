import { Effect, Schema } from "effect";

import { markUntrustedContent } from "../notes/note.ts";
import { recordedTool } from "../personal-agent/recorded-tool.ts";
import { isPinnedMcpTool } from "./mcp-catalog.ts";
import type { McpCatalogEntry } from "./mcp-catalog.ts";
import type { McpToolCopy } from "./mcp-tool-copy.ts";
import type { FingerprintedMcpToolCopy } from "./mcp-tool-fingerprint.ts";
import { callMcpToolToolName, findMcpToolsToolName } from "./mcp-tool-names.ts";
import {
  connectionDescription,
  entryOrFail,
  stateOrFail,
  stateText,
} from "./mcp-tool-services.ts";
import type { McpToolServices } from "./mcp-tool-services.ts";

export const maxFoundMcpToolDetails = 5;
const maxIndexedMcpTools = 40;
const indexedDescriptionCharacters = 80;

const FindMcpToolsInput = Schema.Struct({
  connection: Schema.String.pipe(
    Schema.annotate({ description: connectionDescription })
  ),
  query: Schema.String.pipe(
    Schema.annotate({
      description:
        "A few keywords for the tool that you need, for example search or page. Leave it empty to list the tools.",
    })
  ),
});

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word.length >= 2);

const scoreOf = (queryWords: readonly string[], tool: McpToolCopy) => {
  const haystack = `${tool.name} ${tool.description}`.toLowerCase();
  return queryWords.filter((word) => haystack.includes(word)).length;
};

const matchingTools = (
  query: string,
  tools: readonly FingerprintedMcpToolCopy[]
) => {
  const queryWords = words(query);
  if (queryWords.length === 0) {
    return tools;
  }
  return tools
    .map((tool) => ({ tool, score: scoreOf(queryWords, tool) }))
    .filter(({ score }) => score > 0)
    .toSorted((left, right) => right.score - left.score)
    .map(({ tool }) => tool);
};

const toolDetails = (tool: McpToolCopy) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
});

const toolIndexLine = (tool: McpToolCopy) =>
  `- ${tool.name}: ${tool.description.slice(0, indexedDescriptionCharacters)}`;

const splitByPin = (
  entry: McpCatalogEntry,
  tools: readonly FingerprintedMcpToolCopy[]
) => ({
  pinned: tools.filter((tool) => isPinnedMcpTool(entry, tool)),
  unpinned: tools.filter((tool) => !isPinnedMcpTool(entry, tool)),
});

const detailsOf = (
  entry: McpCatalogEntry,
  matches: readonly FingerprintedMcpToolCopy[]
) => {
  const { pinned, unpinned } = splitByPin(entry, matches);
  return {
    tools: pinned.map(toolDetails),
    ...(unpinned.length === 0
      ? {}
      : {
          unpinnedTools: markUntrustedContent(
            JSON.stringify(unpinned.map(toolDetails))
          ),
        }),
  };
};

const indexOf = (
  entry: McpCatalogEntry,
  matches: readonly FingerprintedMcpToolCopy[]
) => {
  const { pinned, unpinned } = splitByPin(
    entry,
    matches.slice(0, maxIndexedMcpTools)
  );
  return {
    index: pinned.map(toolIndexLine).join("\n"),
    ...(unpinned.length === 0
      ? {}
      : {
          unpinnedIndex: markUntrustedContent(
            unpinned.map(toolIndexLine).join("\n")
          ),
        }),
    notice:
      "There are many matches. Search again with more specific keywords to get the input schema of a tool.",
  };
};

export const findMcpToolsTool = (services: McpToolServices, eventId: string) =>
  recordedTool(
    { eventId, progress: services.progress, redactor: services.redactor },
    {
      name: findMcpToolsToolName,
      description: `Find the tools of a connected service (an MCP Connection) from the copy that code keeps. Returns the best matches with their descriptions and input schemas, or a short index when the query is broad. A definition that the Operator did not pin comes as Untrusted Content. Call it before ${callMcpToolToolName}. It makes no request to the service.`,
      inputSchema: FindMcpToolsInput,
      riskClass: "read",
      failureMessage: "The tools could not be listed.",
      work: ({ connection, query }) =>
        Effect.gen(function* findEffect() {
          const entry = yield* entryOrFail(services.catalog, connection);
          const state = yield* stateOrFail(services, entry);
          const matches = matchingTools(
            query,
            services.copies.get(entry.catalogId) ?? []
          );
          const header = {
            connection: entry.displayName,
            state: stateText[state],
            matchCount: matches.length,
          };
          return {
            ...header,
            ...(matches.length <= maxFoundMcpToolDetails
              ? detailsOf(entry, matches)
              : indexOf(entry, matches)),
          };
        }),
    }
  );
