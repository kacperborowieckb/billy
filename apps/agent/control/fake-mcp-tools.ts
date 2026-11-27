export interface FakeMcpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations?: Record<string, unknown>;
}

const objectSchema = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
});

export const fakeMcpTools: readonly FakeMcpTool[] = [
  {
    name: "search",
    description: "Search the pages by keywords",
    inputSchema: objectSchema({ query: { type: "string" } }),
    annotations: { readOnlyHint: true },
  },
  {
    name: "fetch",
    description: "Fetch one page by its id",
    inputSchema: objectSchema({ id: { type: "string" } }),
    annotations: { readOnlyHint: true },
  },
  {
    name: "big_dump",
    description: "Return a very large page dump",
    inputSchema: objectSchema({}),
  },
  {
    name: "slow_read",
    description: "Read a page slowly",
    inputSchema: objectSchema({}),
  },
  {
    name: "failing_read",
    description: "Read a page that always fails",
    inputSchema: objectSchema({}),
  },
  {
    name: "poisoned_read",
    description: "Read a page whose text holds instructions",
    inputSchema: objectSchema({}),
  },
  {
    name: "archive_page",
    description: "Archive a page",
    inputSchema: objectSchema({ id: { type: "string" } }),
    annotations: { destructiveHint: true },
  },
  {
    name: "create_page",
    description: "Create a page",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    },
  },
  {
    name: "rename_page",
    description: "Rename a page",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, title: { type: "string" } },
      required: ["id", "title"],
      additionalProperties: false,
    },
  },
  {
    name: "failing_write",
    description: "Write a page that always fails",
    inputSchema: objectSchema({}),
  },
  {
    name: "slow_write",
    description: "Write a page slowly",
    inputSchema: objectSchema({ title: { type: "string" } }),
  },
  {
    name: "wipe_workspace",
    description: "Delete everything",
    inputSchema: objectSchema({}),
  },
  {
    name: "hidden_new_tool",
    description: "A tool that the catalog does not list",
    inputSchema: objectSchema({}),
  },
];
