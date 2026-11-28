import { notionCatalogEntry } from "../../src/mcp/notion/notion-catalog-entry.ts";
import type { FakeMcpTool } from "../fake-mcp-tools.ts";

const descriptionCharacters = 4000;

const text = { type: "string" };

const flag = { type: "boolean" };

const texts = { type: "array", items: text };

const objectSchema = (
  properties: Record<string, unknown>,
  required: readonly string[]
) => ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const parent = {
  anyOf: ["page_id", "database_id", "data_source_id", "teamspace_id"].map(
    (field) => ({
      type: "object",
      properties: { [field]: text },
      required: [field],
    })
  ),
};

const documentedInputSchemas: Readonly<
  Record<string, Record<string, unknown>>
> = {
  "notion-search": objectSchema(
    {
      query: text,
      query_type: { type: "string", enum: ["internal", "user"] },
      filters: {
        type: "object",
        properties: {
          created_by_user_ids: texts,
          edited_by_user_ids: texts,
          title_only: flag,
        },
      },
      page_size: { type: "integer", minimum: 1, maximum: 50 },
    },
    ["query"]
  ),
  "notion-fetch": objectSchema({ id: text, include_file_urls: flag }, ["id"]),
  "notion-create-pages": objectSchema(
    {
      parent,
      pages: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            properties: {
              type: "object",
              additionalProperties: { type: ["string", "number", "null"] },
            },
            content: text,
            icon: text,
            cover: text,
            is_skill: flag,
          },
        },
      },
      creation_mode: { type: "string", enum: ["draft"] },
      allow_async: flag,
    },
    ["pages"]
  ),
  "notion-update-page": {
    ...objectSchema(
      {
        page_id: text,
        command: {
          type: "string",
          enum: ["update_properties", "update_content", "replace_content"],
        },
        properties: { type: "object" },
        new_str: text,
        content_updates: {
          type: "array",
          items: { $ref: "#/$defs/contentUpdate" },
        },
        allow_deleting_content: flag,
      },
      ["page_id", "command"]
    ),
    $defs: {
      contentUpdate: {
        type: "object",
        properties: {
          old_str: text,
          new_str: text,
          replace_all_matches: flag,
        },
        required: ["old_str", "new_str"],
      },
    },
  },
};

const readOnlyTools: ReadonlySet<string> = new Set([
  "notion-search",
  "notion-fetch",
]);

const descriptionOf = (name: string) => {
  const sentence = `${name.replaceAll("-", " ")}: reads or changes the Notion workspace of the signed-in user. `;
  return sentence
    .repeat(Math.ceil(descriptionCharacters / sentence.length))
    .slice(0, descriptionCharacters);
};

export const fakeNotionTools: readonly FakeMcpTool[] =
  notionCatalogEntry.tools.map(({ name }) => ({
    name,
    description: descriptionOf(name),
    inputSchema:
      documentedInputSchemas[name] ??
      objectSchema({ page_id: text, query: text }, []),
    ...(readOnlyTools.has(name) ? { annotations: { readOnlyHint: true } } : {}),
  }));
