import type { McpCatalog, McpCatalogEntry } from "./mcp-catalog.ts";
import { mcpCatalogProblems } from "./mcp-catalog.ts";

export const testMcpCatalogId = "test_server";

export const testMcpCatalogEntry = (serverUrl: string): McpCatalogEntry => ({
  catalogId: testMcpCatalogId,
  displayName: "Test server",
  description: "A test-only MCP server with fake pages.",
  serverUrl,
  tools: [
    {
      name: "search",
      riskClass: "read",
      resultIds: { field: "id", shape: { _tag: "Uuid" } },
    },
    { name: "fetch", riskClass: "read" },
    { name: "big_dump", riskClass: "read" },
    { name: "slow_read", riskClass: "read" },
    { name: "failing_read", riskClass: "read" },
    { name: "poisoned_read", riskClass: "read" },
    {
      name: "archive_page",
      riskClass: "read",
      summary: "archive page {id}",
    },
    {
      name: "create_page",
      riskClass: "approve",
      summary: "create page {title}",
    },
    {
      name: "rename_page",
      riskClass: "change",
      summary: "rename page {id} to {title}",
    },
    {
      name: "slow_write",
      riskClass: "approve",
      summary: "write page {title}",
    },
    {
      name: "failing_write",
      riskClass: "approve",
      summary: "write a failing page",
    },
    { name: "wipe_workspace", riskClass: "blocked" },
  ],
});

export const productionMcpCatalog: McpCatalog = [];

export const mcpCatalogFor = (env: {
  readonly MCP_TEST_SERVER_URL: string;
}): McpCatalog => {
  const catalog =
    env.MCP_TEST_SERVER_URL === ""
      ? productionMcpCatalog
      : [...productionMcpCatalog, testMcpCatalogEntry(env.MCP_TEST_SERVER_URL)];
  const problems = mcpCatalogProblems(catalog);
  if (problems.length > 0) {
    throw new Error(`The MCP Catalog is invalid: ${problems.join("; ")}`);
  }
  return catalog;
};
