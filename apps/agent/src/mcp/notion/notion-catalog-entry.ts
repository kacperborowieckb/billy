import type { McpCatalogEntry, McpCatalogTool } from "../mcp-catalog.ts";
import { notionAgentSummaries } from "./notion-agent-summaries.ts";
import { notionCalendarSummaries } from "./notion-calendar-summaries.ts";
import { notionCommentSummaries } from "./notion-comment-summaries.ts";
import { notionDatabaseSummaries } from "./notion-database-summaries.ts";
import { notionPageSummaries } from "./notion-page-summaries.ts";
import { notionWorkspaceSummaries } from "./notion-workspace-summaries.ts";

const workspaceReadToolNames: ReadonlySet<string> = new Set([
  "notion-list-private-pages",
  "notion-list-shared-pages",
  "notion-list-favorite-pages",
  "notion-list-recent-pages",
  "notion-list-page-backlinks",
  "notion-get-self",
  "notion-get-teams",
  "notion-get-users",
  "notion-get-groups",
  "notion-get-comments",
  "notion-get-suggested-edit",
  "notion-view-version",
  "notion-get-version-changes",
  "notion-query-meeting-notes",
  "notion-query-data-sources",
  "notion-query-multiple-data-sources",
]);

const searchAndFetchTools: readonly McpCatalogTool[] = [
  {
    name: "notion-search",
    riskClass: "read",
    resultIds: { field: "id", shape: { _tag: "Uuid" } },
  },
  { name: "notion-fetch", riskClass: "read" },
];

const summarizedTools: readonly McpCatalogTool[] = Object.entries({
  ...notionPageSummaries,
  ...notionDatabaseSummaries,
  ...notionCommentSummaries,
  ...notionWorkspaceSummaries,
  ...notionAgentSummaries,
  ...notionCalendarSummaries,
}).map(([name, summary]) => ({
  name,
  riskClass: workspaceReadToolNames.has(name) ? "read" : "approve",
  summary,
}));

export const notionCatalogEntry: McpCatalogEntry = {
  catalogId: "notion",
  displayName: "Notion",
  description:
    "The Owner's Notion workspace: pages, databases, comments, and calendar.",
  serverUrl: "https://mcp.notion.com/mcp",
  tools: [...searchAndFetchTools, ...summarizedTools],
};
