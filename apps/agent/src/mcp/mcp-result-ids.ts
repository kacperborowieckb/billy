import { matchesMcpIdShape } from "./mcp-catalog.ts";
import type { McpIdShape } from "./mcp-catalog.ts";

export interface McpResultId {
  readonly position: number;
  readonly id: string | number;
}

export interface McpResultIds {
  readonly resultCount: number;
  readonly ids: readonly McpResultId[];
}

const valuesOfField = (value: unknown, field: string, found: unknown[]) => {
  if (Array.isArray(value)) {
    for (const item of value) {
      valuesOfField(item, field, found);
    }
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  for (const [key, inner] of Object.entries(value)) {
    if (key === field) {
      found.push(inner);
    } else {
      valuesOfField(inner, field, found);
    }
  }
};

const parsedJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export const mcpResultIdsOf = (
  { field, shape }: { readonly field: string; readonly shape: McpIdShape },
  text: string,
  structured: unknown
): McpResultIds => {
  const found: unknown[] = [];
  valuesOfField(structured ?? parsedJson(text), field, found);
  return {
    resultCount: found.length,
    ids: found.flatMap((value, index) =>
      matchesMcpIdShape(shape, value) &&
      (typeof value === "string" || typeof value === "number")
        ? [{ position: index + 1, id: value }]
        : []
    ),
  };
};
