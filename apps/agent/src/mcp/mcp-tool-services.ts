import { Effect } from "effect";

import type { RiskClass } from "../approval/risk-class.ts";
import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import type { Journal } from "../journal/journal.ts";
import { ToolFailed } from "../model-gateway/agent-tool.ts";
import type { McpConnectionState } from "../personal-agent/storage-values.ts";
import type { TurnProgress } from "../personal-agent/turn-progress.ts";
import type { Redactor } from "../tracing/redactor.ts";
import { mcpEntryOf, mcpToolRiskClass } from "./mcp-catalog.ts";
import type { McpCatalog, McpCatalogEntry } from "./mcp-catalog.ts";
import type { McpHubPort } from "./mcp-hub-contract.ts";
import type { McpToolCopy } from "./mcp-tool-copy.ts";

export interface McpToolServices {
  readonly catalog: McpCatalog;
  readonly states: ReadonlyMap<string, McpConnectionState>;
  readonly copies: ReadonlyMap<string, readonly McpToolCopy[]>;
  readonly hub: McpHubPort["Service"];
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

export const annotationsOf = (
  copies: McpToolServices["copies"],
  catalogId: string,
  toolName: string
) => copies.get(catalogId)?.find((tool) => tool.name === toolName)?.annotations;

export const mcpCallRiskClass = (
  services: Pick<McpToolServices, "catalog" | "copies">,
  input: { readonly connection: string; readonly tool: string }
): RiskClass => {
  const entry = mcpEntryOf(services.catalog, input.connection);
  const annotations = annotationsOf(
    services.copies,
    input.connection,
    input.tool
  );
  if (entry === undefined || annotations === undefined) {
    return "read";
  }
  return mcpToolRiskClass(entry, input.tool, annotations) === "read"
    ? "read"
    : "blocked";
};
