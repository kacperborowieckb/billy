import type { McpCatalog } from "./mcp-catalog.ts";
import type { McpConnectionRecord } from "./mcp-connections.ts";
import { findMcpToolsToolName } from "./mcp-tool-names.ts";

export interface McpConnectionsView {
  readonly catalog: McpCatalog;
  readonly states: readonly McpConnectionRecord[];
}

const stateLabels = {
  authenticating: "waiting for the Owner to sign in",
  ready: "ready",
  failed: "not working",
  needs_sign_in: "needs a new sign-in",
} as const;

export const mcpConnectionsSection = ({
  catalog,
  states,
}: McpConnectionsView): readonly string[] => {
  if (catalog.length === 0) {
    return [];
  }
  const stateOf = new Map(states.map((row) => [row.catalogId, row.state]));
  const connected = catalog.filter((entry) => stateOf.has(entry.catalogId));
  const notConnected = catalog.filter((entry) => !stateOf.has(entry.catalogId));
  return [
    connected.length === 0
      ? "The Owner has no MCP Connections."
      : `MCP Connections of the Owner (use ${findMcpToolsToolName} with the catalog id). Each line shows the catalog id, the name, and the state:`,
    ...connected.map((entry) => {
      const state = stateOf.get(entry.catalogId);
      return `- ${entry.catalogId} (${entry.displayName}): ${state === undefined ? "unknown" : stateLabels[state]}`;
    }),
    ...(notConnected.length === 0
      ? []
      : [
          "Services that the Owner can connect but has not connected:",
          ...notConnected.map(
            (entry) => `- ${entry.catalogId} (${entry.displayName})`
          ),
        ]),
  ];
};
