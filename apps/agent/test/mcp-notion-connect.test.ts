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
