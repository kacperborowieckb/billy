import type { McpCatalogEntry, McpCatalogTool } from "../mcp-catalog.ts";
import { notionAgentSummaries } from "./notion-agent-summaries.ts";
import { notionCalendarSummaries } from "./notion-calendar-summaries.ts";
import { notionCommentSummaries } from "./notion-comment-summaries.ts";
import { notionDatabaseSummaries } from "./notion-database-summaries.ts";
import { notionPageSummaries } from "./notion-page-summaries.ts";
import { notionWorkspaceSummaries } from "./notion-workspace-summaries.ts";

const readTools: readonly McpCatalogTool[] = [
  {
    name: "notion-search",
    riskClass: "read",
    resultIds: { field: "id", shape: { _tag: "Uuid" } },
  },
  { name: "notion-fetch", riskClass: "read" },
];

const approvalTools: readonly McpCatalogTool[] = Object.entries({
  ...notionPageSummaries,
  ...notionDatabaseSummaries,
  ...notionCommentSummaries,
  ...notionWorkspaceSummaries,
  ...notionAgentSummaries,
  ...notionCalendarSummaries,
}).map(([name, summary]) => ({ name, riskClass: "approve", summary }));

export const notionCatalogEntry: McpCatalogEntry = {
  catalogId: "notion",
  displayName: "Notion",
  description:
    "The Owner's Notion workspace: pages, databases, comments, and calendar.",
  serverUrl: "https://mcp.notion.com/mcp",
  tools: [...readTools, ...approvalTools],
};
