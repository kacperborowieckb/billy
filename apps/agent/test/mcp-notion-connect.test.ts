import { runInDurableObject } from "cloudflare:test";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakeOAuthSecrets } from "../control/fake-oauth-server.ts";
import { fakeNotionTools } from "../control/mcp-flow/fake-notion-tools.ts";
import { McpConnections } from "../src/mcp/mcp-connections.ts";
import { notionCatalogEntry } from "../src/mcp/notion/notion-catalog-entry.ts";
import { fakeMcpServer, fakeTelegram, resetFakes } from "./fakes.ts";
import {
  loginOf,
  postConsent,
  startedAuthorizationOf,
} from "./mcp-connect-requests.ts";
import {
  agentOf,
  journalOf,
  newTelegramUserId,
  ownerWhoWroteToTheAgent,
  statesOf,
} from "./mcp-oauth-flow.ts";
import { sendToEdge } from "./telegram-requests.ts";

const notionOrigin = new URL(notionCatalogEntry.serverUrl).origin;

const connectNotion = async () => {
  const telegramUserId = newTelegramUserId();
  const ownerId = await ownerWhoWroteToTheAgent(telegramUserId);
  const login = await loginOf(telegramUserId, ownerId);
  login.set("c", notionCatalogEntry.catalogId);
  const authorization = await startedAuthorizationOf(await postConsent(login));
  const callback = await sendToEdge(
    new Request(
      `https://agent.test/oauth/callback?${new URLSearchParams({
        code: fakeOAuthSecrets.authorizationCode,
        state: authorization.searchParams.get("state") ?? "",
        iss: notionOrigin,
      })}`
    )
  );
  return { ownerId, callback };
};

const storedToolsOf = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (agent) =>
    agent.runtime.runPromise(
      McpConnections.pipe(
        Effect.flatMap((connections) =>
          connections.tools(notionCatalogEntry.catalogId)
        )
      )
    )
  );

beforeEach(() => {
  resetFakes();
});

describe("a completion for an entry that the Catalog does not hold", () => {
  it("logs the reason and no account name", async () => {
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...parts) => {
      lines.push(parts.map(String).join(" "));
    });
    const ownerId = await ownerWhoWroteToTheAgent(newTelegramUserId());

    const agent = await agentOf(ownerId);

    await agent.receiveMcpConnected({
      catalogId: "removed_entry",
      tools: [],
      accountLabel: "Pat Reader",
      completionId: "completion-1",
    });
    log.mockRestore();

    const output = lines.join("\n");
    expect(output).toContain(
      '"phase":"completion","reason":"unknown_catalog_entry","catalogId":"removed_entry"'
    );
    expect(output).not.toContain("Pat Reader");
  });
});

describe("the log of a tool catalog copy", () => {
  it("names the tools that differ from the Catalog and their marks, and no description", async () => {
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...parts) => {
      lines.push(parts.map(String).join(" "));
    });
    fakeMcpServer.useTools([
      ...fakeNotionTools.filter(({ name }) => name !== "notion-get-self"),
      {
        name: "notion-new-tool",
        description: "A private description",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
      },
    ]);

    await connectNotion();
    log.mockRestore();

    const logged = lines.find((line) => line.includes("MCP tool catalog"));
    expect(logged).toContain('"toolCount":74');
    expect(logged).toContain('"notInCatalog":["notion-new-tool"]');
    expect(logged).toContain('"catalogToolsNotListed":["notion-get-self"]');
    expect(logged).toContain(
      '"markedReadOnly":["notion-search","notion-fetch","notion-new-tool"]'
    );
    expect(logged).not.toContain("private description");
  });
});

describe("a Notion connection with a tool list of the real size", () => {
  it("stores every tool, tells the Owner, and writes the Journal Entry", async () => {
    fakeMcpServer.useTools(fakeNotionTools);

    const { ownerId, callback } = await connectNotion();

    expect(callback.status).toBe(200);
    await vi.waitFor(() =>
      expect(fakeTelegram.sent.at(-1)?.body.text).toBe(
        "Connected Notion (account Pat Reader)"
      )
    );
    expect(await statesOf(ownerId)).toEqual([
      { catalogId: notionCatalogEntry.catalogId, state: "ready" },
    ]);
    const stored = await storedToolsOf(ownerId);
    expect(stored.toSorted((a, b) => a.name.localeCompare(b.name))).toEqual(
      fakeNotionTools
        .map(({ name, description, inputSchema, annotations }) => ({
          name,
          description,
          inputSchema,
          annotations: annotations ?? {},
        }))
        .toSorted((a, b) => a.name.localeCompare(b.name))
    );
    expect(await journalOf(ownerId)).toContainEqual(
      expect.objectContaining({ _tag: "McpConnectionAdded" })
    );
  });
});
