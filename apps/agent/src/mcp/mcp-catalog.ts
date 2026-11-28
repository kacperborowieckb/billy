import { Schema } from "effect";

import { riskClasses } from "../approval/risk-class.ts";
import type { RiskClass } from "../approval/risk-class.ts";
import {
  summaryFieldPattern,
  summaryOptionalPartPattern,
  summaryPathsOf,
  summaryPlaceholderPattern,
} from "./mcp-summary-template.ts";

const maxHexIdLength = 64;
const minHexIdLength = 16;

export const McpIdShapeSchema = Schema.TaggedUnion({
  Uuid: {},
  Hex: {
    length: Schema.Int.pipe(
      Schema.check(
        Schema.isBetween({ minimum: minHexIdLength, maximum: maxHexIdLength })
      )
    ),
  },
  Number: {},
});

export type McpIdShape = typeof McpIdShapeSchema.Type;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export const matchesMcpIdShape = (shape: McpIdShape, value: unknown) => {
  switch (shape._tag) {
    case "Uuid": {
      return typeof value === "string" && uuidPattern.test(value);
    }
    case "Hex": {
      return (
        typeof value === "string" &&
        value.length === shape.length &&
        /^[0-9a-f]+$/u.test(value)
      );
    }
    case "Number": {
      return typeof value === "number" && Number.isSafeInteger(value);
    }
    default: {
      return shape satisfies never;
    }
  }
};

const catalogIdPattern = /^[a-z][a-z0-9_]{0,31}$/u;
const toolNamePattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const fieldNamePattern = /^[A-Za-z][A-Za-z0-9_]{0,31}$/u;
const maxSummaryTemplateLength = 300;

const McpCatalogToolSchema = Schema.Struct({
  name: Schema.String.pipe(Schema.check(Schema.isPattern(toolNamePattern))),
  riskClass: Schema.Literals(riskClasses),
  summary: Schema.optionalKey(
    Schema.String.pipe(
      Schema.check(
        Schema.isMinLength(1),
        Schema.isMaxLength(maxSummaryTemplateLength)
      )
    )
  ),
  resultIds: Schema.optionalKey(
    Schema.Struct({
      field: Schema.String.pipe(
        Schema.check(Schema.isPattern(fieldNamePattern))
      ),
      shape: McpIdShapeSchema,
    })
  ),
});

export const McpCatalogEntrySchema = Schema.Struct({
  catalogId: Schema.String.pipe(
    Schema.check(Schema.isPattern(catalogIdPattern))
  ),
  displayName: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  description: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  serverUrl: Schema.String.pipe(
    Schema.check(Schema.isPattern(/^https?:\/\/\S+$/u))
  ),
  tools: Schema.Array(McpCatalogToolSchema),
});

export type McpCatalogEntry = typeof McpCatalogEntrySchema.Type;
export type McpCatalogTool = McpCatalogEntry["tools"][number];

export type McpCatalog = readonly McpCatalogEntry[];

const decodeEntry = Schema.decodeUnknownResult(McpCatalogEntrySchema);

const summaryProblemsOf = (catalogId: string, tool: McpCatalogTool) => {
  const template = tool.summary ?? "";
  const problems = [...template.matchAll(summaryPlaceholderPattern)]
    .map(([, placeholder]) => placeholder ?? "")
    .filter((placeholder) =>
      summaryPathsOf(placeholder).some(
        (path) => !summaryFieldPattern.test(path)
      )
    )
    .map(
      (placeholder) =>
        `${catalogId} has a summary template for ${tool.name} with the invalid placeholder {${placeholder}}`
    );
  if (/[[\]]/u.test(template.replaceAll(summaryOptionalPartPattern, ""))) {
    problems.push(
      `${catalogId} has a summary template for ${tool.name} with an unmatched bracket`
    );
  }
  return problems;
};

export const mcpCatalogProblems = (entries: readonly unknown[]) => {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const decoded = decodeEntry(entry);
    if (decoded._tag === "Failure") {
      problems.push(`An MCP Catalog entry is invalid: ${decoded.failure}`);
      continue;
    }
    const { catalogId, tools } = decoded.success;
    if (seen.has(catalogId)) {
      problems.push(`The MCP Catalog lists ${catalogId} twice`);
    }
    seen.add(catalogId);
    const names = new Set<string>();
    for (const tool of tools) {
      if (names.has(tool.name)) {
        problems.push(`${catalogId} lists the tool ${tool.name} twice`);
      }
      names.add(tool.name);
      problems.push(...summaryProblemsOf(catalogId, tool));
      if (tool.resultIds !== undefined && tool.riskClass !== "read") {
        problems.push(
          `${catalogId} declares result ids for ${tool.name}, which is not a read tool`
        );
      }
    }
  }
  return problems;
};

export const mcpEntryOf = (catalog: McpCatalog, catalogId: string) =>
  catalog.find((entry) => entry.catalogId === catalogId);

export const mcpCatalogToolOf = (entry: McpCatalogEntry, toolName: string) =>
  entry.tools.find((tool) => tool.name === toolName);

export interface McpToolAnnotations {
  readonly destructiveHint?: boolean | undefined;
}

const raisedBy = (declared: RiskClass, annotations: McpToolAnnotations) =>
  annotations.destructiveHint === true && declared !== "blocked"
    ? "approve"
    : declared;

export const mcpToolRiskClass = (
  entry: McpCatalogEntry,
  toolName: string,
  annotations: McpToolAnnotations
): RiskClass => {
  const listed = mcpCatalogToolOf(entry, toolName);
  return raisedBy(listed?.riskClass ?? "approve", annotations);
};
