import { env, runInDurableObject } from "cloudflare:test";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakeOAuthSecrets } from "../control/fake-oauth-server.ts";
import { defaultBehaviorConfig } from "../src/behavior/behavior-config.ts";
import { McpConnections } from "../src/mcp/mcp-connections.ts";
import { testMcpCatalogId } from "../src/mcp/mcp-test-catalog.ts";
import { callMcpToolToolName } from "../src/mcp/mcp-tool-names.ts";
import { SealedCredentials } from "../src/mcp/sealed-credentials.ts";
import { parseSealKeyring } from "../src/mcp/token-seal.ts";
import {
  fakeMcpServer,
  fakeModel,
  fakeTelegram,
  resetFakes,
  scriptModel,
} from "./fakes.ts";
import { nowSeconds } from "./mcp-connect-requests.ts";
import {
  agentOf,
  connectedOwner,
  everythingStoredFor,
  goodCallback,
  hubOf,
  newTelegramUserId,
  ownerWhoWroteToTheAgent,
  searchOf,
  startedConsent,
  statesOf,
  stateChangesOf,
  storedTokensOf,
} from "./mcp-oauth-flow.ts";
import {
  sendToEdge,
  telegramWebhook,
  textUpdate,
} from "./telegram-requests.ts";

const { oauth } = fakeMcpServer;

const slowTest = 30_000;

beforeEach(() => {
  resetFakes();
  oauth.issueFreshTokens(true);
  oauth.requireToken(true);
});

const waitingOf = (ownerId: string) =>
  runInDurableObject(hubOf(ownerId), (instance) =>
    (
      instance as unknown as {
        completionsWaitingFor: (catalogId: string) => number;
      }
    ).completionsWaitingFor(testMcpCatalogId)
  );

const expireAndRevoke = () => {
  oauth.revokeRefreshTokens();
  oauth.expireAccessToken();
};

const driveToNeedsSignIn = async (ownerId: string) => {
  expireAndRevoke();
  expect(await searchOf(ownerId)).toEqual({
    _tag: "Failed",
    reason: "needs_sign_in",
  });
};

const tagOf = async (outcome: Promise<{ readonly _tag: string }>) => {
  const settled = await outcome;
  return settled._tag;
};

const statusOf = async (response: Promise<Response> | Response) => {
  const settled = await response;
  return settled.status;
};

const storedRefreshTokenOf = async (ownerId: string) => {
  const tokens = await storedTokensOf(ownerId);
  return tokens?.refresh_token;
};

const stateOf = async (ownerId: string) => {
  const states = await statesOf(ownerId);
  return states.find(({ catalogId }) => catalogId === testMcpCatalogId)?.state;
};

describe("one refresh at a time", () => {
  it(
    "makes one token request for two calls that both need a refresh",
    async () => {
      const { ownerId } = await connectedOwner();
      oauth.expireAccessToken();
      const release = oauth.holdTokenRequests();

      const calls = [searchOf(ownerId), searchOf(ownerId)];
      await vi.waitFor(() => expect(oauth.refreshRequests).toHaveLength(1));
      await vi.waitFor(async () => expect(await waitingOf(ownerId)).toBe(1));
      release();
      const outcomes = await Promise.all(calls);

      expect(outcomes.map(({ _tag }) => _tag)).toEqual(["Result", "Result"]);
      expect(oauth.refreshRequests).toHaveLength(1);
    },
    slowTest
  );

  it(
    "lets a call that is already running finish while another call refreshes",
    async () => {
      const { ownerId } = await connectedOwner();
      const releaseCall = fakeMcpServer.holdToolCalls();
      const running = searchOf(ownerId);
      await vi.waitFor(() => expect(fakeMcpServer.toolCallRequests).toBe(1));
      fakeMcpServer.holdToolCalls()();
      oauth.expireAccessToken();

      const refreshing = searchOf(ownerId);
      await vi.waitFor(() => expect(oauth.refreshRequests).toHaveLength(1));
      releaseCall();

      expect(await tagOf(running)).toBe("Result");
      expect(await tagOf(refreshing)).toBe("Result");
      expect(oauth.refreshRequests).toHaveLength(1);
    },
    slowTest
  );

  it(
    "refreshes before the call when the stored token is about to expire",
    async () => {
      const { ownerId } = await connectedOwner();
      const keyring = await parseSealKeyring(env.MCP_SEALING_KEYS);
      await runInDurableObject(hubOf(ownerId), async (_i, { storage }) => {
        const credentials = new SealedCredentials(storage, keyring, ownerId);
        const tokens = await credentials.tokens(testMcpCatalogId);
        if (tokens === undefined) {
          throw new Error("no tokens");
        }
        await credentials.saveTokens(testMcpCatalogId, {
          ...tokens,
          expires_in: 1,
        });
      });

      expect(await tagOf(searchOf(ownerId))).toBe("Result");
      expect(oauth.refreshRequests).toHaveLength(1);
    },
    slowTest
  );
});

describe("the refresh token", () => {
  it(
    "keeps the old refresh token when the response has no new one",
    async () => {
      const { ownerId } = await connectedOwner();
      oauth.expireAccessToken();
      expect(await tagOf(searchOf(ownerId))).toBe("Result");
      oauth.expireAccessToken();
      expect(await tagOf(searchOf(ownerId))).toBe("Result");

      expect(oauth.refreshRequests.map((r) => r["refresh_token"])).toEqual([
        fakeOAuthSecrets.refreshToken,
        fakeOAuthSecrets.refreshToken,
      ]);
      expect(await storedRefreshTokenOf(ownerId)).toBe(
        fakeOAuthSecrets.refreshToken
      );
    },
    slowTest
  );

  it(
    "stores a rotated refresh token and presents it next time",
    async () => {
      oauth.rotateRefreshTokens(true);
      const { ownerId } = await connectedOwner();
      oauth.expireAccessToken();
      expect(await tagOf(searchOf(ownerId))).toBe("Result");
      oauth.expireAccessToken();
      expect(await tagOf(searchOf(ownerId))).toBe("Result");

      const [first, second] = oauth.refreshRequests;
      expect(first?.["refresh_token"]).toBe(fakeOAuthSecrets.refreshToken);
      expect(second?.["refresh_token"]).toBe(
        `${fakeOAuthSecrets.refreshToken}-rotated-1`
      );
    },
    slowTest
  );

  it(
    "ends in needs sign-in when a rotated refresh token was lost after the provider accepted it",
    async () => {
      oauth.rotateRefreshTokens(true);
      const { ownerId } = await connectedOwner();
      oauth.expireAccessToken();
      oauth.cutRefreshResponseBodies(true);

      expect(await searchOf(ownerId)).toEqual({
        _tag: "Failed",
        reason: "failed",
      });
      expect(await stateOf(ownerId)).toBe("ready");

      oauth.cutRefreshResponseBodies(false);
      expect(await searchOf(ownerId)).toEqual({
        _tag: "Failed",
        reason: "needs_sign_in",
      });
      expect(oauth.refreshRequests.map((r) => r["refresh_token"])).toEqual([
        fakeOAuthSecrets.refreshToken,
        fakeOAuthSecrets.refreshToken,
      ]);
      expect(await stateOf(ownerId)).toBe("needs_sign_in");
    },
    slowTest
  );

  it(
    "keeps the Connection ready when the token endpoint is down",
    async () => {
      const { ownerId } = await connectedOwner();
      oauth.expireAccessToken();
      oauth.failRefreshesWith(503);

      expect(await searchOf(ownerId)).toEqual({
        _tag: "Failed",
        reason: "failed",
      });

      expect(await stateOf(ownerId)).toBe("ready");
      expect(await hubOf(ownerId).lastError(testMcpCatalogId)).toEqual(
        expect.objectContaining({
          phase: "refresh",
          reason: "unavailable",
          httpStatus: 503,
        })
      );
    },
    slowTest
  );
});

describe("a Connection that needs a new sign-in", () => {
  it(
    "moves to needs sign-in on invalid_grant, writes the Journal Entry, and keeps no secret",
    async () => {
      const { ownerId } = await connectedOwner();

      await driveToNeedsSignIn(ownerId);

      expect(await stateOf(ownerId)).toBe("needs_sign_in");
      expect(await stateChangesOf(ownerId)).toEqual([
        "authenticating",
        "ready",
        "needs_sign_in",
      ]);
      expect(await hubOf(ownerId).lastError(testMcpCatalogId)).toEqual({
        phase: "refresh",
        reason: "invalid_grant",
        httpStatus: 400,
        atMillis: expect.any(Number),
      });
      const stored = await everythingStoredFor(ownerId);
      expect(stored).not.toContain(fakeOAuthSecrets.refreshToken);
      expect(stored).not.toContain(fakeOAuthSecrets.accessToken);
      expect(await storedTokensOf(ownerId)).toBeUndefined();
    },
    slowTest
  );

  it(
    "does not touch the server again while it needs sign-in",
    async () => {
      const { ownerId } = await connectedOwner();
      await driveToNeedsSignIn(ownerId);
      const { requests } = fakeMcpServer;

      expect(await searchOf(ownerId)).toEqual({
        _tag: "Failed",
        reason: "needs_sign_in",
      });

      expect(fakeMcpServer.requests).toBe(requests);
    },
    slowTest
  );

  it(
    "moves to needs sign-in when the server still answers 401 after a refresh",
    async () => {
      const { ownerId } = await connectedOwner();
      fakeMcpServer.refuseAllTokens(true);

      expect(await searchOf(ownerId)).toEqual({
        _tag: "Failed",
        reason: "needs_sign_in",
      });

      expect(oauth.refreshRequests).toHaveLength(1);
      expect(await stateOf(ownerId)).toBe("needs_sign_in");
      expect(await hubOf(ownerId).lastError(testMcpCatalogId)).toEqual(
        expect.objectContaining({ phase: "request", reason: "unauthorized" })
      );
    },
    slowTest
  );

  it(
    "fails a call that needs more scope, makes no background sign-in, and moves to needs sign-in",
    async () => {
      const { ownerId } = await connectedOwner();
      fakeMcpServer.demandMoreScope(true);

      expect(await searchOf(ownerId)).toEqual({
        _tag: "Failed",
        reason: "insufficient_scope",
      });

      expect(oauth.refreshRequests).toHaveLength(0);
      expect(await stateOf(ownerId)).toBe("needs_sign_in");
      expect(await hubOf(ownerId).lastError(testMcpCatalogId)).toEqual(
        expect.objectContaining({
          phase: "request",
          reason: "insufficient_scope",
          httpStatus: 403,
        })
      );
    },
    slowTest
  );

  it(
    "gives the next Delivery that uses the Connection exactly one reconnect button and no claim of success",
    async () => {
      const { ownerId, telegramUserId } = await connectedOwner();
      await driveToNeedsSignIn(ownerId);
      const sentBefore = fakeTelegram.sent.length;
      scriptModel([
        {
          callTool: callMcpToolToolName,
          input: {
            connection: testMcpCatalogId,
            tool: "search",
            arguments: { query: "reading" },
          },
          times: 2,
        },
        {
          say: "I could not read your pages. Tap the button to sign in again.",
        },
      ]);

      await telegramWebhook(
        textUpdate({ fromUserId: telegramUserId, text: "search my pages" })
      );
      await vi.waitFor(() =>
        expect(fakeTelegram.sent.length).toBeGreaterThan(sentBefore + 1)
      );

      const sent = fakeTelegram.sent.slice(sentBefore);
      expect(sent.map(({ body }) => body.text)).toEqual([
        "I could not read your pages. Tap the button to sign in again.",
        "Reconnect Test server",
      ]);
      expect(
        sent.filter(({ body }) => body.reply_markup !== undefined)
      ).toHaveLength(1);
      expect(
        JSON.stringify(fakeModel.doGenerateCalls.at(-1)?.prompt)
      ).toContain("Never say that it is done");
      expect(fakeMcpServer.calls).toEqual([]);
    },
    slowTest
  );
});

describe("a reconnect next to calls that are still running", () => {
  it(
    "retries a call that the server rejected with the old token after a reconnect that was still exchanging its code",
    async () => {
      const { ownerId, telegramUserId } = await connectedOwner();
      oauth.expireAccessToken();
      const releaseStaleCall = fakeMcpServer.holdToolCalls();
      const staleCall = searchOf(ownerId);
      await vi.waitFor(() => expect(fakeMcpServer.toolCallRequests).toBe(1));
      fakeMcpServer.holdToolCalls()();
      oauth.revokeRefreshTokens();
      expect(await searchOf(ownerId)).toEqual({
        _tag: "Failed",
        reason: "needs_sign_in",
      });
      const { state } = await startedConsent(
        telegramUserId,
        ownerId,
        nowSeconds() - 5
      );
      const releaseExchange = oauth.holdTokenRequests();
      const callback = goodCallback(state);
      await vi.waitFor(() =>
        expect(
          oauth.tokenRequests.filter(
            (request) => request["grant_type"] === "authorization_code"
          )
        ).toHaveLength(2)
      );

      releaseStaleCall();
      await vi.waitFor(async () => expect(await waitingOf(ownerId)).toBe(1));
      releaseExchange();

      expect(await statusOf(callback)).toBe(200);
      expect(await tagOf(staleCall)).toBe("Result");
      expect(oauth.refreshRequests).toHaveLength(1);
      expect(await stateOf(ownerId)).toBe("ready");
      expect(await stateChangesOf(ownerId)).toEqual([
        "authenticating",
        "ready",
        "needs_sign_in",
        "ready",
      ]);
    },
    slowTest
  );
});

describe("other entries into the queue of the Connection", () => {
  it(
    "does not let a replay of the first callback bring back ready after the tokens were deleted",
    async () => {
      const telegramUserId = newTelegramUserId();
      const ownerId = await ownerWhoWroteToTheAgent(telegramUserId);
      const { state } = await startedConsent(telegramUserId, ownerId);
      await goodCallback(state);
      await driveToNeedsSignIn(ownerId);

      await goodCallback(state);

      expect(await stateOf(ownerId)).toBe("needs_sign_in");
      expect(await storedTokensOf(ownerId)).toBeUndefined();
    },
    slowTest
  );

  it(
    "finishes a callback whose connect is refused, with the cleanup under the same rules",
    async () => {
      const telegramUserId = newTelegramUserId();
      const ownerId = await ownerWhoWroteToTheAgent(telegramUserId);
      const { state } = await startedConsent(telegramUserId, ownerId);
      fakeMcpServer.refuseAllTokens(true);

      const callback = await goodCallback(state);

      expect(callback.status).toBe(502);
      expect(await stateOf(ownerId)).toBe("failed");
    },
    slowTest
  );

  it(
    "makes an Operator add wait for a refresh that is running",
    async () => {
      const { ownerId } = await connectedOwner();
      expireAndRevoke();
      const release = oauth.holdTokenRequests();
      const refreshing = searchOf(ownerId);
      await vi.waitFor(() => expect(oauth.refreshRequests).toHaveLength(1));

      const adding = hubOf(ownerId).addConnection(
        testMcpCatalogId,
        defaultBehaviorConfig.mcpConnectTimeoutMillis
      );
      await vi.waitFor(async () => expect(await waitingOf(ownerId)).toBe(1));
      release();
      await refreshing;
      await adding;

      expect(await stateOf(ownerId)).toBe("needs_sign_in");
    },
    slowTest
  );

  it(
    "refreshes an expired token during an explicit catalog refresh",
    async () => {
      const { ownerId } = await connectedOwner();
      oauth.expireAccessToken();

      const outcome = await hubOf(ownerId).refreshToolCatalog(
        testMcpCatalogId,
        defaultBehaviorConfig.mcpConnectTimeoutMillis
      );

      expect(outcome).toEqual({ outcome: "refreshed" });
      expect(oauth.refreshRequests).toHaveLength(1);
    },
    slowTest
  );
});

describe("stored credentials and the Operator add", () => {
  it(
    "reads an old sealed client record with no token endpoint and moves to needs sign-in at the next refresh",
    async () => {
      const { ownerId } = await connectedOwner();
      const keyring = await parseSealKeyring(env.MCP_SEALING_KEYS);
      const clientRead = await runInDurableObject(
        hubOf(ownerId),
        async (_i, { storage }) => {
          const credentials = new SealedCredentials(storage, keyring, ownerId);
          const tokens = await credentials.tokens(testMcpCatalogId);
          if (tokens === undefined) {
            throw new Error("no tokens");
          }
          await storage.put(
            await credentials.sealedEntries(testMcpCatalogId, tokens, {
              client_id: "old-client",
              redirectUrl: "https://agent.test/oauth/callback",
            })
          );
          return credentials.client(testMcpCatalogId);
        }
      );
      oauth.expireAccessToken();

      expect(clientRead?.client_id).toBe("old-client");
      expect(await searchOf(ownerId)).toEqual({
        _tag: "Failed",
        reason: "needs_sign_in",
      });
      expect(oauth.refreshRequests).toHaveLength(0);
      expect(await stateOf(ownerId)).toBe("needs_sign_in");
    },
    slowTest
  );

  it(
    "refreshes stored tokens before an Operator add connects",
    async () => {
      const { ownerId } = await connectedOwner();
      const keyring = await parseSealKeyring(env.MCP_SEALING_KEYS);
      await runInDurableObject(hubOf(ownerId), async (_i, { storage }) => {
        const credentials = new SealedCredentials(storage, keyring, ownerId);
        const tokens = await credentials.tokens(testMcpCatalogId);
        if (tokens === undefined) {
          throw new Error("no tokens");
        }
        await credentials.saveTokens(testMcpCatalogId, {
          ...tokens,
          expires_in: 1,
        });
      });
      oauth.expireAccessToken();

      const added = await hubOf(ownerId).addConnection(
        testMcpCatalogId,
        defaultBehaviorConfig.mcpConnectTimeoutMillis
      );

      expect(added).toEqual({ outcome: "added" });
      expect(oauth.refreshRequests).toHaveLength(1);
    },
    slowTest
  );
});

describe("the catalog copy follows the server", () => {
  it(
    "updates the copy when the server sends tools/list_changed",
    async () => {
      fakeMcpServer.streamNotifications(true);
      const { ownerId } = await connectedOwner();
      await vi.waitFor(() =>
        expect(fakeMcpServer.hasNotificationStream).toBe(true)
      );
      fakeMcpServer.listHiddenTools();

      await runInDurableObject(hubOf(ownerId), () => {
        fakeMcpServer.notifyToolsListChanged();
      });

      await vi.waitFor(
        async () =>
          expect(await toolNamesOf(ownerId)).toContain("hidden_new_tool"),
        { timeout: 10_000 }
      );
    },
    slowTest
  );

  it(
    "updates the copy on an explicit refresh",
    async () => {
      const { ownerId } = await connectedOwner();
      fakeMcpServer.listHiddenTools();

      expect(
        await hubOf(ownerId).refreshToolCatalog(
          testMcpCatalogId,
          defaultBehaviorConfig.mcpConnectTimeoutMillis
        )
      ).toEqual({ outcome: "refreshed" });

      expect(await toolNamesOf(ownerId)).toContain("hidden_new_tool");
    },
    slowTest
  );
});

const operatorRefresh = (ownerId: string, token: string | null) =>
  sendToEdge(
    new Request("https://agent.test/operator/mcp-connections/refresh", {
      method: "POST",
      headers: token === null ? {} : { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ownerId, catalogId: testMcpCatalogId }),
    })
  );

describe("the Operator refresh route", () => {
  it(
    "refreshes the tool copy for the Operator and shows the sanitized last error",
    async () => {
      const { ownerId } = await connectedOwner();
      fakeMcpServer.listHiddenTools();

      const refused = await operatorRefresh(ownerId, null);
      const refreshed = await operatorRefresh(ownerId, env.OPERATOR_TOKEN);

      expect(refused.status).toBe(401);
      expect(await refreshed.json()).toEqual({
        outcome: "refreshed",
        lastError: null,
      });
      expect(await toolNamesOf(ownerId)).toContain("hidden_new_tool");
    },
    slowTest
  );
});

const toolNamesOf = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.runtime.runPromise(
      McpConnections.pipe(
        Effect.flatMap((connections) => connections.tools(testMcpCatalogId)),
        Effect.map((tools) => tools.map(({ name }) => name))
      )
    )
  );
