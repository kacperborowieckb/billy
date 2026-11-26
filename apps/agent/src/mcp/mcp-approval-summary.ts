import type { McpCatalogEntry } from "./mcp-catalog.ts";
import { mcpCatalogToolOf } from "./mcp-catalog.ts";
import {
  filledSummaryTemplate,
  isScalar,
  shownScalar,
  summaryFieldPattern,
} from "./mcp-summary-template.ts";

const maxGenericValues = 2;

const maxToolTitleLength = 48;

const toolTitleOf = (toolName: string) =>
  toolName
    .replaceAll(/[^A-Za-z0-9]+/gu, " ")
    .trim()
    .slice(0, maxToolTitleLength)
    .toLowerCase();

const genericValuesOf = (args: Readonly<Record<string, unknown>>) =>
  Object.entries(args)
    .filter(([key, value]) => summaryFieldPattern.test(key) && isScalar(value))
    .slice(0, maxGenericValues)
    .map(([key, value]) => `${key}: ${shownScalar(value as string)}`);

const genericLineOf = (
  entry: McpCatalogEntry,
  toolName: string,
  args: Readonly<Record<string, unknown>>
) => {
  const values = genericValuesOf(args);
  const title = toolTitleOf(toolName);
  return values.length === 0
    ? `${entry.displayName}: ${title}`
    : `${entry.displayName}: ${title} (${values.join(", ")})`;
};

export const mcpApprovalSummaryOf = (
  entry: McpCatalogEntry,
  toolName: string,
  args: Readonly<Record<string, unknown>>
) => {
  const template = mcpCatalogToolOf(entry, toolName)?.summary;
  return template === undefined
    ? genericLineOf(entry, toolName, args)
    : `${entry.displayName}: ${filledSummaryTemplate(template, args)}`;
};
