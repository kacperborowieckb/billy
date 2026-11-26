import { matchesMcpIdShape } from "./mcp-catalog.ts";
import type { McpIdShape } from "./mcp-catalog.ts";

export const maxStubIds = 50;

export interface McpResultId {
  readonly position: number;
  readonly id: string | number;
}

export interface McpResultIds {
  readonly resultCount: number;
  readonly ids: readonly McpResultId[];
  readonly omittedIds: number;
}

const hasField = (item: unknown, field: string) =>
  typeof item === "object" && item !== null && Object.hasOwn(item, field);

const resultListOf = (value: unknown, field: string): unknown[] | undefined => {
  if (Array.isArray(value)) {
    if (value.some((item) => hasField(item, field))) {
      return value;
    }
    for (const item of value) {
      const inner = resultListOf(item, field);
      if (inner !== undefined) {
        return inner;
      }
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  if (hasField(value, field)) {
    return [value];
  }
  for (const inner of Object.values(value)) {
    const found = resultListOf(inner, field);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
};

const parsedJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const validIdOf = (item: unknown, field: string, shape: McpIdShape) => {
  const value = hasField(item, field)
    ? (item as Record<string, unknown>)[field]
    : undefined;
  return matchesMcpIdShape(shape, value) &&
    (typeof value === "string" || typeof value === "number")
    ? value
    : undefined;
};

export const mcpResultIdsOf = (
  { field, shape }: { readonly field: string; readonly shape: McpIdShape },
  text: string
): McpResultIds => {
  const results = resultListOf(parsedJson(text), field) ?? [];
  const valid = results.flatMap((item, index) => {
    const id = validIdOf(item, field, shape);
    return id === undefined ? [] : [{ position: index + 1, id }];
  });
  return {
    resultCount: results.length,
    omittedIds: Math.max(0, valid.length - maxStubIds),
    ids: valid.slice(0, maxStubIds),
  };
};
