import { Effect, Schema } from "effect";

import { markUntrustedContent } from "../notes/note.ts";
import { recordedTool } from "../personal-agent/recorded-tool.ts";
import type { McpToolCopy } from "./mcp-tool-copy.ts";
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

const matchingTools = (query: string, tools: readonly McpToolCopy[]) => {
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

export const findMcpToolsTool = (services: McpToolServices, eventId: string) =>
  recordedTool(
    { eventId, progress: services.progress, redactor: services.redactor },
    {
      name: findMcpToolsToolName,
      description: `Find the tools of a connected service (an MCP Connection) from the copy that code keeps. Returns the best matches with their descriptions and input schemas, or a short index when the query is broad. Call it before ${callMcpToolToolName}. It makes no request to the service.`,
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
          return matches.length <= maxFoundMcpToolDetails
            ? {
                ...header,
                tools: markUntrustedContent(
                  JSON.stringify(matches.map(toolDetails))
                ),
              }
            : {
                ...header,
                index: markUntrustedContent(
                  matches
                    .slice(0, maxIndexedMcpTools)
                    .map(toolIndexLine)
                    .join("\n")
                ),
                notice:
                  "There are many matches. Search again with more specific keywords to get the input schema of a tool.",
              };
        }),
    }
  );
