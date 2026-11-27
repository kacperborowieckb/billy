import type { McpCatalog } from "./mcp-catalog.ts";
import { mcpCatalogProblems } from "./mcp-catalog.ts";
import { testMcpCatalogEntry } from "./mcp-test-catalog.ts";
import { notionCatalogEntry } from "./notion/notion-catalog-entry.ts";

export const productionMcpCatalog: McpCatalog = [notionCatalogEntry];

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
