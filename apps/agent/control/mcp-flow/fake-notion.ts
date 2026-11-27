import { createFakeMcpServer, textResult } from "../fake-mcp-server.ts";
import type { FakeMcpTool } from "../fake-mcp-tools.ts";

export const fakeNotionOrigin = "https://mcp.notion.com";

export const fakeNotionWorkspaceName = "Acme Workspace";

export const fakeNotionPageIds = {
  readingList: "1b4e28ba-2fa1-41d2-883f-0016d3cca427",
  tripPlan: "9f8b1c3e-5d2a-4c7b-9e1f-6a4d2b8c0e13",
} as const;

const pages = [
  {
    id: fakeNotionPageIds.readingList,
    title: "Reading list",
    text: "Project Hail Mary, Piranesi",
  },
  {
    id: fakeNotionPageIds.tripPlan,
    title: "Trip plan",
    text: "Lisbon in May",
  },
] as const;

const urlOf = (id: string) => `https://www.notion.so/${id.replaceAll("-", "")}`;

const objectSchema = (
  properties: Record<string, unknown>,
  required: readonly string[]
) => ({ type: "object", properties, required });

const text = { type: "string" };

const parent = { type: "object" };

export const fakeNotionTools: readonly FakeMcpTool[] = [
  {
    name: "notion-search",
    description: "Search pages and databases by topic or title",
    inputSchema: objectSchema({ query: text }, ["query"]),
    annotations: { readOnlyHint: true },
  },
  {
    name: "notion-fetch",
    description: "Open a page or database by its id",
    inputSchema: objectSchema({ id: text }, ["id"]),
    annotations: { readOnlyHint: true },
  },
  {
    name: "notion-create-pages",
    description: "Create one or more pages",
    inputSchema: objectSchema(
      { parent, pages: { type: "array", items: { type: "object" } } },
      ["pages"]
    ),
  },
  {
    name: "notion-update-page",
    description: "Update the properties or content of a page",
    inputSchema: objectSchema({ page_id: text, command: text }, [
      "page_id",
      "command",
    ]),
  },
];

const created = {
  id: "4c1d7f90-8a3b-4e62-b5d1-2f9a6c0b7e44",
  url: urlOf("4c1d7f90-8a3b-4e62-b5d1-2f9a6c0b7e44"),
};

const answerNotionTool = (name: string, args: Record<string, unknown>) => {
  switch (name) {
    case "notion-search": {
      return textResult(
        JSON.stringify({
          type: "workspace_search",
          results: pages.map(({ id, title }) => ({
            id,
            title,
            url: urlOf(id),
          })),
        })
      );
    }
    case "notion-fetch": {
      const page = pages.find(({ id }) => id === args["id"]);
      return page === undefined
        ? textResult("No such page", true)
        : textResult(JSON.stringify({ ...page, url: urlOf(page.id) }));
    }
    case "notion-create-pages": {
      return textResult(JSON.stringify({ pages: [created] }));
    }
    default: {
      return textResult(`ran ${name}`);
    }
  }
};

export const createFakeNotion = () => {
  const server = createFakeMcpServer({
    tools: fakeNotionTools,
    answerTool: answerNotionTool,
  });
  server.oauth.requireToken(true);
  server.oauth.sendAccountName(false);
  server.oauth.sendWorkspaceName(fakeNotionWorkspaceName);
  server.oauth.revokeAtTokenEndpoint(true);
  server.oauth.registerWithMethod("none");
  return server;
};
