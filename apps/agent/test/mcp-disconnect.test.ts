import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakeOAuthSecrets } from "../control/fake-oauth-server.ts";
import { testMcpCatalogId } from "../src/mcp/mcp-test-catalog.ts";
import {
  callMcpToolToolName,
  connectMcpServerToolName,
  disconnectMcpConnectionToolName,
  findMcpToolsToolName,
} from "../src/mcp/mcp-tool-names.ts";
import { removeMcpConnection } from "../src/mcp/receive-mcp-copy.ts";
import {
  fakeMcpServer,
  fakeModel,
  fakeTelegram,
  resetFakes,
  scriptModel,
} from "./fakes.ts";
import { loginOf, nowSeconds, postConsent } from "./mcp-connect-requests.ts";
import {
  agentOf,
  connectedOwner,
  everythingStoredFor,
  goodCallback,
  hubOf,
  journalOf,
  newTelegramUserId,
  ownerWhoWroteToTheAgent,
  searchOf,
  startedConsent,
  statesOf,
  stateChangesOf,
  storedTokensOf,
} from "./mcp-oauth-flow.ts";
import {
  pressUpdate,
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

const outcomeOf = async (work: Promise<{ readonly outcome: string }>) => {
  const settled = await work;
  return settled.outcome;
};

const statusOf = async (work: Promise<Response> | Response) => {
  const settled = await work;
  return settled.status;
};

const tagOf = async (work: Promise<{ readonly _tag: string }>) => {
  const settled = await work;
  return settled._tag;
};

const lastToolOutputOf = (toolName: string) => {
  const prompt = fakeModel.doGenerateCalls.at(-1)?.prompt ?? [];
  const part = prompt
    .flatMap((message) => (message.role === "tool" ? message.content : []))
    .findLast(
      (candidate) =>
        candidate.type === "tool-result" && candidate.toolName === toolName
    );
  return JSON.stringify(part?.type === "tool-result" ? part.output : undefined);
};

const waitingOf = (ownerId: string) =>
  runInDurableObject(hubOf(ownerId), (instance) =>
    (
      instance as unknown as {
        completionsWaitingFor: (catalogId: string) => number;
      }
    ).completionsWaitingFor(testMcpCatalogId)
  );

const disconnectOf = (ownerId: string) =>
  hubOf(ownerId).disconnect(testMcpCatalogId);

const removalsOf = async (ownerId: string) => {
  const records = await journalOf(ownerId);
  return records.flatMap((record) =>
    record._tag === "McpConnectionRemoved" ? [record.revocation] : []
  );
};

const hubKeysOf = (ownerId: string) =>
  runInDurableObject(hubOf(ownerId), async (_instance, { storage }) => {
    const stored = await storage.list();
    return [...stored.keys()];
  });

const approvalStatesOf = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (_instance, { storage }) =>
    storage.sql
      .exec<{ state: string }>("SELECT state FROM pending_approvals")
      .toArray()
      .map((row) => row.state)
  );

const expectAgentForgot = async (ownerId: string) => {
  expect(await statesOf(ownerId)).toEqual([]);
};

const expectNothingLeft = async (ownerId: string) => {
  expect(await storedTokensOf(ownerId)).toBeUndefined();
  const keys = await hubKeysOf(ownerId);
  expect(
    keys.filter(
      (key) => key.includes(testMcpCatalogId) && !key.startsWith("removing:")
    )
  ).toEqual([]);
  expect(keys.filter((key) => /^(?:oauth|settled):/u.test(key))).toEqual([]);
};

const approveButtonOf = () =>
  vi.waitFor(() => {
    const button = fakeTelegram.sent
      .flatMap((request) => request.body.reply_markup?.inline_keyboard ?? [])
      .flat()
      .findLast((candidate) => candidate.text === "Approve");
    if (button === undefined) {
      throw new Error("No Approval message was sent yet");
    }
    return { text: button.text, callback_data: button.callback_data };
  });

const say = async (userId: number, text: string, sentSoFar: number) => {
  await telegramWebhook(textUpdate({ fromUserId: userId, text }));
  await vi.waitFor(() =>
    expect(fakeTelegram.sent.length).toBeGreaterThan(sentSoFar)
  );
};

describe("disconnect in an owner Turn", () => {
  it(
    "revokes the token, deletes the record, tokens, and tool copy, and writes McpConnectionRemoved",
    async () => {
      const { ownerId, telegramUserId } = await connectedOwner();
      scriptModel([
        {
          callTool: disconnectMcpConnectionToolName,
          input: { connection: testMcpCatalogId },
        },
        { say: "Disconnected." },
      ]);

      await say(
        telegramUserId,
        "disconnect the test server",
        fakeTelegram.sent.length
      );

      await vi.waitFor(async () =>
        expect(await removalsOf(ownerId)).toEqual(["revoked"])
      );
      expect(
        oauth.revocationRequests.map((request) => request["token_type_hint"])
      ).toEqual(["refresh_token", "access_token"]);
      expect(
        oauth.revocationRequests.map((request) => request["token"])
      ).toContain(fakeOAuthSecrets.refreshToken);
      await expectNothingLeft(ownerId);
      await expectAgentForgot(ownerId);
      expect(await everythingStoredFor(ownerId)).not.toContain(
        fakeOAuthSecrets.refreshToken
      );
    },
    slowTest
  );

  it(
    "answers not connected to find_mcp_tools and call_mcp_tool afterwards",
    async () => {
      const { ownerId } = await connectedOwner();
      expect(await disconnectOf(ownerId)).toEqual({
        outcome: "disconnected",
        revocation: "revoked",
      });

      expect(await searchOf(ownerId)).toEqual({
        _tag: "Failed",
        reason: "not_connected",
      });
      expect(fakeMcpServer.toolCallRequests).toBe(0);
    },
    slowTest
  );

  it(
    "needs Approval in an untrusted Turn and revokes only after Approve",
    async () => {
      const { ownerId, telegramUserId } = await connectedOwner();
      scriptModel([
        {
          callTool: callMcpToolToolName,
          input: {
            connection: testMcpCatalogId,
            tool: "search",
            arguments: { query: "reading" },
          },
        },
        {
          callTool: disconnectMcpConnectionToolName,
          input: { connection: testMcpCatalogId },
        },
        { say: "Waiting for your Approval." },
      ]);

      await say(
        telegramUserId,
        "read then disconnect",
        fakeTelegram.sent.length
      );

      const approve = await approveButtonOf();
      expect(approve.text).toBe("Approve");
      expect(oauth.revocationRequests).toEqual([]);
      expect(await storedTokensOf(ownerId)).toBeDefined();

      await telegramWebhook(
        pressUpdate({
          fromUserId: telegramUserId,
          data: approve.callback_data,
          messageId: fakeTelegram.sent.length,
        })
      );
      await vi.waitFor(async () =>
        expect(await removalsOf(ownerId)).toEqual(["revoked"])
      );
      await expectNothingLeft(ownerId);
      await expectAgentForgot(ownerId);
    },
    slowTest
  );

  it(
    "deletes everything and records the failure in the Journal when the provider answers 500",
    async () => {
      const { ownerId, telegramUserId } = await connectedOwner();
      oauth.failRevocationsWith(500);
      scriptModel([
        {
          callTool: disconnectMcpConnectionToolName,
          input: { connection: testMcpCatalogId },
        },
        { say: "Disconnected, but the service did not confirm." },
      ]);

      await say(telegramUserId, "disconnect", fakeTelegram.sent.length);

      await vi.waitFor(async () =>
        expect(await removalsOf(ownerId)).toEqual(["failed"])
      );
      await expectNothingLeft(ownerId);
      await expectAgentForgot(ownerId);
    },
    slowTest
  );
});

describe("revocation that does not work", () => {
  it(
    "deletes everything and records the failure when the provider answers 500",
    async () => {
      const { ownerId } = await connectedOwner();
      oauth.failRevocationsWith(500);

      expect(await disconnectOf(ownerId)).toEqual({
        outcome: "disconnected",
        revocation: "failed",
      });

      await expectNothingLeft(ownerId);
    },
    slowTest
  );

  it(
    "deletes everything when the revocation body never ends, after the deadline",
    async () => {
      const { ownerId } = await connectedOwner();
      oauth.cutRevocationBodies(true);

      expect(await disconnectOf(ownerId)).toEqual({
        outcome: "disconnected",
        revocation: "failed",
      });

      await expectNothingLeft(ownerId);
    },
    slowTest
  );

  it(
    "makes no revocation request when the authorization server has no endpoint",
    async () => {
      oauth.advertiseRevocation(false);
      const { ownerId } = await connectedOwner();

      expect(await disconnectOf(ownerId)).toEqual({
        outcome: "disconnected",
        revocation: "not_attempted",
      });

      expect(oauth.revocationRequests).toEqual([]);
      await expectNothingLeft(ownerId);
    },
    slowTest
  );

  it(
    "deletes everything locally while the revocation is still waiting",
    async () => {
      const { ownerId } = await connectedOwner();
      const release = oauth.holdRevocations();

      const disconnecting = disconnectOf(ownerId);
      await vi.waitFor(() =>
        expect(oauth.revocationRequests.length).toBeGreaterThan(0)
      );
      expect(await storedTokensOf(ownerId)).toBeUndefined();
      release();

      expect(await outcomeOf(disconnecting)).toBe("disconnected");
    },
    slowTest
  );
});

describe("one state machine for each catalog entry", () => {
  it(
    "disconnects after a callback that holds the queue and refuses a callback that waited behind the disconnect",
    async () => {
      const userId = newTelegramUserId();
      const ownerId = await ownerWhoWroteToTheAgent(userId);
      const first = await startedConsent(userId, ownerId);
      const second = await startedConsent(userId, ownerId, nowSeconds() - 71);
      const release = oauth.holdTokenRequests();

      const firstCallback = goodCallback(first.state);
      await vi.waitFor(() => expect(oauth.tokenRequests).toHaveLength(1));
      const disconnecting = disconnectOf(ownerId);
      await vi.waitFor(async () => expect(await waitingOf(ownerId)).toBe(1));
      const secondCallback = goodCallback(second.state);
      await vi.waitFor(async () => expect(await waitingOf(ownerId)).toBe(2));
      release();

      expect(await statusOf(firstCallback)).toBe(200);
      expect(await outcomeOf(disconnecting)).toBe("disconnected");
      await secondCallback;
      expect(oauth.tokenRequests).toHaveLength(1);
      await expectNothingLeft(ownerId);
    },
    slowTest
  );

  it(
    "ends a refresh that ran before the disconnect and leaves no state behind",
    async () => {
      const { ownerId } = await connectedOwner();
      oauth.expireAccessToken();
      const release = oauth.holdTokenRequests();
      const calling = searchOf(ownerId);
      await vi.waitFor(() => expect(oauth.refreshRequests).toHaveLength(1));
      const disconnecting = disconnectOf(ownerId);
      await vi.waitFor(async () => expect(await waitingOf(ownerId)).toBe(1));
      release();

      await calling;
      expect(await outcomeOf(disconnecting)).toBe("disconnected");
      await expectNothingLeft(ownerId);
      expect(await stateChangesOf(ownerId)).not.toContain("needs_sign_in");
    },
    slowTest
  );

  it(
    "fails a call that was running and leaves no sign-in state",
    async () => {
      const { ownerId } = await connectedOwner();
      const releaseCall = fakeMcpServer.holdToolCalls();
      const running = searchOf(ownerId);
      await vi.waitFor(() => expect(fakeMcpServer.toolCallRequests).toBe(1));

      expect(await outcomeOf(disconnectOf(ownerId))).toBe("disconnected");
      releaseCall();

      await vi.waitFor(() => expect(fakeMcpServer.calls).toHaveLength(1));
      expect(await running).toEqual({
        _tag: "Failed",
        reason: "not_connected",
      });
      await expectNothingLeft(ownerId);
      expect(await stateChangesOf(ownerId)).not.toContain("needs_sign_in");
    },
    slowTest
  );

  it(
    "settles nothing when a callback is replayed after a disconnect",
    async () => {
      const userId = newTelegramUserId();
      const ownerId = await ownerWhoWroteToTheAgent(userId);
      const { state } = await startedConsent(userId, ownerId);
      await goodCallback(state);
      await disconnectOf(ownerId);
      const exchanges = oauth.tokenRequests.length;

      await goodCallback(state);

      expect(oauth.tokenRequests).toHaveLength(exchanges);
      await expectNothingLeft(ownerId);
      const journal = await journalOf(ownerId);
      expect(
        journal.filter((record) => record._tag === "McpConnectionAdded")
      ).toHaveLength(1);
    },
    slowTest
  );

  it(
    "connects again right after a disconnect",
    async () => {
      const { ownerId, telegramUserId } = await connectedOwner();
      await disconnectOf(ownerId);
      await hubOf(ownerId).acknowledgeRemoval(testMcpCatalogId);

      const { state } = await startedConsent(
        telegramUserId,
        ownerId,
        nowSeconds() - 37
      );
      expect(await statusOf(goodCallback(state))).toBe(200);

      expect(await tagOf(searchOf(ownerId))).toBe("Result");
      expect(await storedTokensOf(ownerId)).toBeDefined();
      const states = await statesOf(ownerId);
      expect(states.map(({ state: stored }) => stored)).toEqual(["ready"]);
    },
    slowTest
  );

  it(
    "disconnects twice without error",
    async () => {
      const { ownerId } = await connectedOwner();
      await disconnectOf(ownerId);

      expect(await outcomeOf(disconnectOf(ownerId))).toBe("disconnected");

      await expectNothingLeft(ownerId);
    },
    slowTest
  );

  it("refuses an unknown catalog entry", async () => {
    const { ownerId } = await connectedOwner();

    expect(await hubOf(ownerId).disconnect("nope")).toEqual({
      outcome: "unknown_catalog_entry",
    });
  });
});

describe("a Pending Approval for a disconnected server", () => {
  it(
    "expires and never runs, also after a reconnect",
    async () => {
      const { ownerId, telegramUserId } = await connectedOwner();
      scriptModel([
        {
          callTool: callMcpToolToolName,
          input: {
            connection: testMcpCatalogId,
            tool: "create_page",
            arguments: { title: "New" },
          },
        },
        { say: "Waiting for your Approval." },
      ]);
      await say(telegramUserId, "create a page", fakeTelegram.sent.length);
      const approve = await approveButtonOf();

      scriptModel([
        {
          callTool: disconnectMcpConnectionToolName,
          input: { connection: testMcpCatalogId },
        },
        { say: "Disconnected." },
      ]);
      await say(telegramUserId, "disconnect", fakeTelegram.sent.length);
      await vi.waitFor(async () =>
        expect(await removalsOf(ownerId)).toEqual(["revoked"])
      );
      const { state } = await startedConsent(
        telegramUserId,
        ownerId,
        nowSeconds() - 37
      );
      await goodCallback(state);
      await vi.waitFor(async () => {
        await runDurableObjectAlarm(await agentOf(ownerId));
        expect(await approvalStatesOf(ownerId)).toEqual(["expired"]);
      });
      await telegramWebhook(
        pressUpdate({
          fromUserId: telegramUserId,
          data: approve.callback_data,
          messageId: fakeTelegram.sent.length,
        })
      );

      expect(await approvalStatesOf(ownerId)).toEqual(["expired"]);
      expect(fakeMcpServer.calls).toEqual([]);
    },
    slowTest
  );
});

describe("a Turn that disconnects", () => {
  it(
    "answers not connected to find_mcp_tools and call_mcp_tool later in the same Turn",
    async () => {
      const { telegramUserId } = await connectedOwner();
      scriptModel([
        {
          callTool: disconnectMcpConnectionToolName,
          input: { connection: testMcpCatalogId },
        },
        {
          callTool: findMcpToolsToolName,
          input: { connection: testMcpCatalogId, query: "search" },
        },
        {
          callTool: callMcpToolToolName,
          input: {
            connection: testMcpCatalogId,
            tool: "search",
            arguments: { query: "reading" },
          },
        },
        { say: "Done." },
      ]);

      await say(telegramUserId, "disconnect", fakeTelegram.sent.length);

      expect(lastToolOutputOf(findMcpToolsToolName)).toContain("not connected");
      expect(lastToolOutputOf(callMcpToolToolName)).toContain("not connected");
      expect(fakeMcpServer.toolCallRequests).toBe(0);
    },
    slowTest
  );

  it(
    "finishes while a callback holds the queue and needs the Personal Agent",
    async () => {
      const userId = newTelegramUserId();
      const ownerId = await ownerWhoWroteToTheAgent(userId);
      const { state } = await startedConsent(userId, ownerId);
      const release = oauth.holdTokenRequests();
      const callback = goodCallback(state);
      await vi.waitFor(() => expect(oauth.tokenRequests).toHaveLength(1));
      scriptModel([
        {
          callTool: disconnectMcpConnectionToolName,
          input: { connection: testMcpCatalogId },
        },
        { say: "Disconnected." },
      ]);

      const asking = telegramWebhook(
        textUpdate({ fromUserId: userId, text: "disconnect" })
      );
      await vi.waitFor(async () => expect(await waitingOf(ownerId)).toBe(1));
      release();

      await asking;
      expect(await statusOf(callback)).toBe(200);
      await vi.waitFor(async () =>
        expect(await removalsOf(ownerId)).toEqual(["revoked"])
      );
      await expectNothingLeft(ownerId);
      await expectAgentForgot(ownerId);
    },
    slowTest
  );
});

describe("an OAuth start that was running", () => {
  it(
    "is refused when it finishes after a disconnect, and works after the Personal Agent removal is acknowledged",
    async () => {
      const userId = newTelegramUserId();
      const ownerId = await ownerWhoWroteToTheAgent(userId);
      const release = oauth.holdMetadataRequests();
      const starting = postConsent(
        await loginOf(userId, ownerId, { authDate: nowSeconds() - 53 })
      );
      await vi.waitFor(() =>
        expect(oauth.heldMetadataRequests).toBeGreaterThan(0)
      );

      expect(await outcomeOf(disconnectOf(ownerId))).toBe("disconnected");
      release();

      expect(await statusOf(starting)).not.toBe(303);
      expect(await hubKeysOf(ownerId)).not.toContainEqual(
        expect.stringMatching(/^oauth:/u)
      );
      await hubOf(ownerId).acknowledgeRemoval(testMcpCatalogId);
      const { state } = await startedConsent(
        userId,
        ownerId,
        nowSeconds() - 59
      );
      expect(await statusOf(goodCallback(state))).toBe(200);
      expect(await tagOf(searchOf(ownerId))).toBe("Result");
    },
    slowTest
  );

  it(
    "makes the Operator add fail while the Personal Agent removal is not acknowledged",
    async () => {
      const { ownerId } = await connectedOwner();
      await disconnectOf(ownerId);

      const added = await hubOf(ownerId).addConnection(testMcpCatalogId, 5000);

      expect(added).toEqual({ outcome: "failed" });
      expect(await storedTokensOf(ownerId)).toBeUndefined();
    },
    slowTest
  );

  it(
    "is refused while the Personal Agent removal is not acknowledged",
    async () => {
      const { ownerId, telegramUserId } = await connectedOwner();
      await disconnectOf(ownerId);

      const refused = await postConsent(
        await loginOf(telegramUserId, ownerId, {
          authDate: nowSeconds() - 61,
        })
      );

      expect(refused.status).not.toBe(303);
      expect(oauth.registrations).toHaveLength(0);
    },
    slowTest
  );
});

describe("an approved call that a disconnect cuts", () => {
  it(
    "is unconfirmed and is not run again",
    async () => {
      const { ownerId, telegramUserId } = await connectedOwner();
      scriptModel([
        {
          callTool: callMcpToolToolName,
          input: {
            connection: testMcpCatalogId,
            tool: "create_page",
            arguments: { title: "New" },
          },
        },
        { say: "Waiting for your Approval." },
      ]);
      await say(telegramUserId, "create a page", fakeTelegram.sent.length);
      const approve = await approveButtonOf();
      const releaseCall = fakeMcpServer.holdToolCalls();

      await telegramWebhook(
        pressUpdate({
          fromUserId: telegramUserId,
          data: approve.callback_data,
          messageId: fakeTelegram.sent.length,
        })
      );
      await vi.waitFor(() => expect(fakeMcpServer.toolCallRequests).toBe(1));
      expect(await outcomeOf(disconnectOf(ownerId))).toBe("disconnected");
      releaseCall();

      await vi.waitFor(async () =>
        expect(await approvalStatesOf(ownerId)).toEqual(["unconfirmed"])
      );
      expect(fakeMcpServer.toolCallRequests).toBe(1);
    },
    slowTest
  );
});

describe("a removal that is not acknowledged", () => {
  it(
    "keeps the first revocation result when a disconnect is repeated",
    async () => {
      const { ownerId } = await connectedOwner();
      oauth.failRevocationsWith(500);

      expect(await disconnectOf(ownerId)).toEqual({
        outcome: "disconnected",
        revocation: "failed",
      });
      oauth.failRevocationsWith(undefined);

      expect(await disconnectOf(ownerId)).toEqual({
        outcome: "disconnected",
        revocation: "failed",
      });
    },
    slowTest
  );

  it(
    "stays blocking until the Personal Agent removal is acknowledged, with no time limit",
    async () => {
      const { ownerId } = await connectedOwner();
      await disconnectOf(ownerId);

      const markers = await runInDurableObject(
        hubOf(ownerId),
        async (_instance, { storage }) => {
          const stored = await storage.list({ prefix: "removing:" });
          return [...stored.values()];
        }
      );

      expect(markers).toEqual(["revoked"]);
    },
    slowTest
  );

  it(
    "is cleared by a connect request when the Personal Agent has no Connection",
    async () => {
      const { ownerId, telegramUserId } = await connectedOwner();
      await disconnectOf(ownerId);
      await runInDurableObject(await agentOf(ownerId), (instance) =>
        instance.runtime.runPromise(
          removeMcpConnection(testMcpCatalogId, "revoked")
        )
      );
      scriptModel([
        {
          callTool: connectMcpServerToolName,
          input: { connection: testMcpCatalogId },
        },
        { say: "Tap the button." },
      ]);

      await say(telegramUserId, "connect again", fakeTelegram.sent.length);

      const markers = await hubKeysOf(ownerId);
      expect(markers.filter((key) => key.startsWith("removing:"))).toEqual([]);
    },
    slowTest
  );

  it(
    "also expires a pending disconnect Approval of the Connection",
    async () => {
      const { ownerId, telegramUserId } = await connectedOwner();
      scriptModel([
        {
          callTool: callMcpToolToolName,
          input: {
            connection: testMcpCatalogId,
            tool: "search",
            arguments: { query: "reading" },
          },
        },
        {
          callTool: disconnectMcpConnectionToolName,
          input: { connection: testMcpCatalogId },
        },
        { say: "Waiting for your Approval." },
      ]);
      await say(
        telegramUserId,
        "read then disconnect",
        fakeTelegram.sent.length
      );
      await approveButtonOf();
      await runInDurableObject(await agentOf(ownerId), (instance) =>
        instance.runtime.runPromise(
          removeMcpConnection(testMcpCatalogId, "revoked")
        )
      );

      await vi.waitFor(async () => {
        await runDurableObjectAlarm(await agentOf(ownerId));
        expect(await approvalStatesOf(ownerId)).toEqual(["expired"]);
      });
    },
    slowTest
  );
});

describe("removing an Owner while a start is running", () => {
  it(
    "leaves no hub storage key when the start resumes after the removal",
    async () => {
      const userId = newTelegramUserId();
      const ownerId = await ownerWhoWroteToTheAgent(userId);
      const release = oauth.holdMetadataRequests();
      const starting = postConsent(
        await loginOf(userId, ownerId, { authDate: nowSeconds() - 97 })
      );
      await vi.waitFor(() =>
        expect(oauth.heldMetadataRequests).toBeGreaterThan(0)
      );

      await hubOf(ownerId).removeOwnerStorage();
      release();

      expect(await statusOf(starting)).not.toBe(303);
      expect(await hubKeysOf(ownerId)).toEqual([]);
    },
    slowTest
  );
});

describe("removing an Owner", () => {
  it(
    "deletes the whole hub storage",
    async () => {
      const { ownerId, telegramUserId } = await connectedOwner();

      await hubOf(ownerId).removeOwnerStorage();

      expect(await hubKeysOf(ownerId)).toEqual([]);
      const refused = await postConsent(
        await loginOf(telegramUserId, ownerId, {
          authDate: nowSeconds() - 83,
        })
      );
      expect(refused.status).not.toBe(303);
      expect(
        await outcomeOf(hubOf(ownerId).addConnection(testMcpCatalogId, 5000))
      ).toBe("failed");
      expect(await hubKeysOf(ownerId)).toEqual([]);
      expect(await hubOf(ownerId).lastError(testMcpCatalogId)).toBeUndefined();
    },
    slowTest
  );
});
