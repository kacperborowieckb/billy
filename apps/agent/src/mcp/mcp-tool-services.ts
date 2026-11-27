import { Effect } from "effect";

import type { RiskClass } from "../approval/risk-class.ts";
import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import type { Journal } from "../journal/journal.ts";
import { ToolFailed } from "../model-gateway/agent-tool.ts";
import type { McpConnectionState } from "../personal-agent/storage-values.ts";
import type { TurnProgress } from "../personal-agent/turn-progress.ts";
import type { Redactor } from "../tracing/redactor.ts";
import { mcpArgumentProblemOf } from "./mcp-arguments.ts";
import { mcpEntryOf, mcpToolRiskClass } from "./mcp-catalog.ts";
import type { McpCatalog, McpCatalogEntry } from "./mcp-catalog.ts";
import type { McpConnections } from "./mcp-connections.ts";
import type { McpHubPort, McpRevocation } from "./mcp-hub-contract.ts";
import type { McpToolCopy } from "./mcp-tool-copy.ts";
import { findMcpToolsToolName } from "./mcp-tool-names.ts";

export interface McpToolServices {
  readonly catalog: McpCatalog;
  readonly states: ReadonlyMap<string, McpConnectionState>;
  readonly copies: ReadonlyMap<string, readonly McpToolCopy[]>;
  readonly hub: McpHubPort["Service"];
  readonly requestConnect: McpConnections["Service"]["requestConnect"];
  readonly removeConnection: (
    catalogId: string,
    revocation: McpRevocation
  ) => Effect.Effect<void>;
  readonly journal: Journal["Service"];
  readonly progress: TurnProgress["Service"];
  readonly redactor: Redactor["Service"];
  readonly behavior: Pick<
    BehaviorConfig,
    | "mcpCallTimeoutMillis"
    | "mcpConnectTimeoutMillis"
    | "mcpResultMaxCharacters"
  >;
}

export const stateText: Readonly<Record<McpConnectionState, string>> = {
  authenticating: "waiting for the Owner to sign in",
  ready: "ready",
  failed: "not working",
  needs_sign_in: "in need of a new sign-in by the Owner",
};

export const reconnectInstruction =
  "The task that needed it is not done. Code adds a Reconnect button to your message. Tell the Owner that the task is not done and that they can tap the button to sign in again. Never say that it is done.";

export const connectionDescription =
  "The catalog id of the MCP Connection, as listed in the Owner Context Block.";

const knownConnectionNames = (catalog: McpCatalog) =>
  catalog.map((entry) => entry.catalogId).join(", ");

export const entryOrFail = (catalog: McpCatalog, catalogId: string) => {
  const entry = mcpEntryOf(catalog, catalogId);
  return entry === undefined
    ? Effect.fail(
        new ToolFailed({
          message: `There is no MCP Connection with the id ${JSON.stringify(catalogId)}. The known ids are: ${knownConnectionNames(catalog) || "none"}.`,
        })
      )
    : Effect.succeed(entry);
};

export const stateOrFail = (
  services: Pick<McpToolServices, "states">,
  entry: McpCatalogEntry
): Effect.Effect<McpConnectionState, ToolFailed> => {
  const state = services.states.get(entry.catalogId);
  return state === undefined
    ? Effect.fail(
        new ToolFailed({
          message: `${entry.displayName} is not connected. Tell the Owner that it is not connected.`,
        })
      )
    : Effect.succeed(state);
};

const copyOf = (
  copies: McpToolServices["copies"],
  catalogId: string,
  toolName: string
) => copies.get(catalogId)?.find((tool) => tool.name === toolName);

export const annotationsOf = (
  copies: McpToolServices["copies"],
  catalogId: string,
  toolName: string
) => copyOf(copies, catalogId, toolName)?.annotations;

interface McpCallInput {
  readonly connection: string;
  readonly tool: string;
  readonly arguments?: Readonly<Record<string, unknown>> | undefined;
}

type CallServices = Pick<McpToolServices, "catalog" | "copies" | "states">;

export const callRefusalOf = (
  services: CallServices,
  input: McpCallInput
): string | undefined => {
  const entry = mcpEntryOf(services.catalog, input.connection);
  if (entry === undefined) {
    return `There is no MCP Connection with the id ${JSON.stringify(input.connection)}. The known ids are: ${knownConnectionNames(services.catalog) || "none"}.`;
  }
  const state = services.states.get(entry.catalogId);
  if (state === undefined) {
    return `${entry.displayName} is not connected. Tell the Owner that it is not connected.`;
  }
  if (state !== "ready") {
    return `${entry.displayName} is ${stateText[state]}. ${reconnectInstruction}`;
  }
  const copy = copyOf(services.copies, input.connection, input.tool);
  if (copy === undefined) {
    return `${entry.displayName} has no tool named ${JSON.stringify(input.tool)}. Use ${findMcpToolsToolName}.`;
  }
  const problem = mcpArgumentProblemOf(copy.inputSchema, input.arguments ?? {});
  return problem === undefined
    ? undefined
    : `The arguments do not match the input schema of ${input.tool}, so the call was refused: ${problem}. Fix the arguments and try again.`;
};

export const mcpCallRiskClass = (
  services: CallServices,
  input: McpCallInput
): RiskClass => {
  const entry = mcpEntryOf(services.catalog, input.connection);
  const annotations = annotationsOf(
    services.copies,
    input.connection,
    input.tool
  );
  if (
    entry === undefined ||
    annotations === undefined ||
    callRefusalOf(services, input) !== undefined
  ) {
    return "read";
  }
  return mcpToolRiskClass(entry, input.tool, annotations);
};
