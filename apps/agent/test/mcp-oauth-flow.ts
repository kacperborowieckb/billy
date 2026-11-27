import { env, runInDurableObject } from "cloudflare:test";
import { Effect } from "effect";
import { expect, vi } from "vitest";

import { fakeOAuthSecrets } from "../control/fake-oauth-server.ts";
import { defaultBehaviorConfig } from "../src/behavior/behavior-config.ts";
import { Journal } from "../src/journal/journal.ts";
import { McpConnections } from "../src/mcp/mcp-connections.ts";
import { testMcpCatalogId } from "../src/mcp/mcp-test-catalog.ts";
import { SealedCredentials } from "../src/mcp/sealed-credentials.ts";
import { parseSealKeyring } from "../src/mcp/token-seal.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { fakeTelegram, scriptModel } from "./fakes.ts";
import { loginOf, postConsent } from "./mcp-connect-requests.ts";
import {
  addOwner,
  sendToEdge,
  telegramWebhook,
  textUpdate,
} from "./telegram-requests.ts";

export const issuer = "https://mcp.test.example";

let nextTelegramUserId = 9400;

export const newTelegramUserId = () => {
  nextTelegramUserId += 1;
  return nextTelegramUserId;
};

export const agentOf = (ownerId: string) =>
  personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId));

export const ownerWhoWroteToTheAgent = async (telegramUserId: number) => {
  const ownerId = await addOwner(telegramUserId);
  scriptModel([{ say: "Hello." }]);
  await telegramWebhook(textUpdate({ fromUserId: telegramUserId, text: "hi" }));
  await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
  return ownerId;
};

export const startedConsent = async (
  telegramUserId: number,
  ownerId: string,
  authDate?: number
) => {
  const response = await postConsent(
    await loginOf(
      telegramUserId,
      ownerId,
      authDate === undefined ? {} : { authDate }
    )
  );
  expect(response.status).toBe(303);
  const location = new URL(response.headers.get("Location") ?? "");
  const state = location.searchParams.get("state") ?? "";
  return { location, state, nonce: state.split(".")[1] ?? "" };
};

export const goodCallback = (state: string) =>
  sendToEdge(
    new Request(
      `https://agent.test/oauth/callback?${new URLSearchParams({
        code: fakeOAuthSecrets.authorizationCode,
        state,
        iss: issuer,
      })}`
    )
  );

export const connectedOwner = async (telegramUserId = newTelegramUserId()) => {
  const ownerId = await ownerWhoWroteToTheAgent(telegramUserId);
  const { state } = await startedConsent(telegramUserId, ownerId);
  const callback = await goodCallback(state);
  expect(callback.status).toBe(200);
  return { ownerId, telegramUserId };
};

export const hubOf = (ownerId: string) => env.MCP_HUB.getByName(ownerId);

export const searchOf = (ownerId: string) =>
  hubOf(ownerId).callTool({
    catalogId: testMcpCatalogId,
    tool: "search",
    arguments: { query: "reading" },
    connectTimeoutMillis: defaultBehaviorConfig.mcpConnectTimeoutMillis,
    callTimeoutMillis: defaultBehaviorConfig.mcpCallTimeoutMillis,
  });

export const statesOf = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.runtime.runPromise(
      McpConnections.pipe(Effect.flatMap((connections) => connections.states))
    )
  );

export const journalOf = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.runtime.runPromise(
      Journal.pipe(
        Effect.flatMap((journal) => journal.read),
        Effect.map((entries) => entries.map(({ record }) => record))
      )
    )
  );

export const stateChangesOf = async (ownerId: string) => {
  const records = await journalOf(ownerId);
  return records.flatMap((record) =>
    record._tag === "McpConnectionStateChanged" ? [record.state] : []
  );
};

export const storedTokensOf = async (ownerId: string) => {
  const keyring = await parseSealKeyring(env.MCP_SEALING_KEYS);
  return runInDurableObject(hubOf(ownerId), (_instance, { storage }) =>
    new SealedCredentials(storage, keyring, ownerId).tokens(testMcpCatalogId)
  );
};

const dumpOf = (sql: SqlStorage) =>
  sql
    .exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'"
    )
    .toArray()
    .flatMap(({ name }) =>
      sql
        .exec(`SELECT * FROM "${name}"`)
        .toArray()
        .map((row) => JSON.stringify(row))
    );

export const everythingStoredFor = async (ownerId: string) => {
  const hub = await runInDurableObject(
    hubOf(ownerId),
    async (_instance, state) => [
      ...dumpOf(state.storage.sql),
      JSON.stringify([...(await state.storage.list())]),
    ]
  );
  const agent = await runInDurableObject(await agentOf(ownerId), (_i, state) =>
    dumpOf(state.storage.sql)
  );
  return [...hub, ...agent].join("\n");
};
