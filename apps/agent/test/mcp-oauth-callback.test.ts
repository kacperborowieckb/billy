import { env, runInDurableObject } from "cloudflare:test";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeOAuthSecrets } from "../control/fake-oauth-server.ts";
import { Journal } from "../src/journal/journal.ts";
import { McpConnections } from "../src/mcp/mcp-connections.ts";
import { testMcpCatalogId } from "../src/mcp/mcp-test-catalog.ts";
import { SealedCredentials } from "../src/mcp/sealed-credentials.ts";
import { parseSealKeyring } from "../src/mcp/token-seal.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import {
  fakeCompletion,
  fakeMcpServer,
  fakeTelegram,
  resetFakes,
  scriptModel,
} from "./fakes.ts";
import {
  loginOf,
  nowSeconds,
  pendingOAuthCountOf,
  postConsent,
  startedAuthorizationOf,
} from "./mcp-connect-requests.ts";
import {
  addOwner,
  sendToEdge,
  telegramWebhook,
  textUpdate,
} from "./telegram-requests.ts";

const issuer = "https://mcp.test.example";

let nextTelegramUserId = 9800;

const newTelegramUserId = () => {
  nextTelegramUserId += 1;
  return nextTelegramUserId;
};

const agentOf = (ownerId: string) =>
  personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId));

const ownerWhoWroteToTheAgent = async (telegramUserId: number) => {
  const ownerId = await addOwner(telegramUserId);
  scriptModel([{ say: "Hello." }]);
  await telegramWebhook(textUpdate({ fromUserId: telegramUserId, text: "hi" }));
  await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
  return ownerId;
};

const startedConsent = async (telegramUserId: number, ownerId: string) => {
  const response = await postConsent(await loginOf(telegramUserId, ownerId));
  const location = await startedAuthorizationOf(response);
  const state = location.searchParams.get("state") ?? "";
  return { location, state, nonce: state.split(".")[1] ?? "" };
};

const callbackWith = (query: Record<string, string>) =>
  sendToEdge(
    new Request(
      `https://agent.test/oauth/callback?${new URLSearchParams(query)}`
    )
  );

const goodCallback = (state: string) =>
  callbackWith({
    code: fakeOAuthSecrets.authorizationCode,
    state,
    iss: issuer,
  });

const statesOf = (ownerId: string) =>
  agentOf(ownerId).then((agent) =>
    runInDurableObject(agent, (instance) =>
      instance.runtime.runPromise(
        McpConnections.pipe(Effect.flatMap((connections) => connections.states))
      )
    )
  );

const toolNamesOf = (ownerId: string) =>
  agentOf(ownerId).then((agent) =>
    runInDurableObject(agent, (instance) =>
      instance.runtime.runPromise(
        McpConnections.pipe(
          Effect.flatMap((connections) => connections.tools(testMcpCatalogId)),
          Effect.map((tools) => tools.map(({ name }) => name))
        )
      )
    )
  );

const journalTagsOf = (ownerId: string) =>
  agentOf(ownerId).then((agent) =>
    runInDurableObject(agent, (instance) =>
      instance.runtime.runPromise(
        Journal.pipe(
          Effect.flatMap((journal) => journal.read),
          Effect.map((entries) => entries.map(({ record }) => record._tag))
        )
      )
    )
  );

const completionsWaitingOf = (ownerId: string) =>
  runInDurableObject(env.MCP_HUB.getByName(ownerId), (instance) =>
    (
      instance as unknown as {
        completionsWaitingFor: (catalogId: string) => number;
      }
    ).completionsWaitingFor(testMcpCatalogId)
  );

const addedEntryCountOf = async (ownerId: string) => {
  const tags = await journalTagsOf(ownerId);
  return tags.filter((tag) => tag === "McpConnectionAdded").length;
};

const statusOfGoodCallback = async (state: string) => {
  const response = await goodCallback(state);
  return response.status;
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

const everythingStoredFor = async (ownerId: string) => {
  const hub = await runInDurableObject(
    env.MCP_HUB.getByName(ownerId),
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

const expectNothingChanged = async (ownerId: string) => {
  expect(fakeMcpServer.oauth.tokenRequests).toEqual([]);
  expect(await statesOf(ownerId)).toEqual([
    { catalogId: testMcpCatalogId, state: "authenticating" },
  ]);
  expect(await journalTagsOf(ownerId)).not.toContain("McpConnectionAdded");
  expect(fakeTelegram.sent).toHaveLength(1);
};

const logged = { lines: [] as string[] };

beforeEach(() => {
  resetFakes();
  logged.lines = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => {
      logged.lines.push(parts.map(String).join(" "));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a good callback", () => {
  it("connects with CIMD, tells the Owner, and writes the Journal Entry", async () => {
    fakeMcpServer.oauth.requireToken(true);
    const ownerId = await ownerWhoWroteToTheAgent(9971);
    const { location, state } = await startedConsent(9971, ownerId);

    const response = await goodCallback(state);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Test server is connected");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(await statesOf(ownerId)).toEqual([
      { catalogId: testMcpCatalogId, state: "ready" },
    ]);
    expect(await toolNamesOf(ownerId)).toContain("search");
    expect(fakeTelegram.sent.at(-1)?.body).toEqual({
      chat_id: 9971,
      text: "Connected Test server (account Pat Reader)",
    });
    expect(await journalTagsOf(ownerId)).toContain("McpConnectionAdded");
    const [exchange] = fakeMcpServer.oauth.tokenRequests;
    expect(exchange).toEqual(
      expect.objectContaining({
        grant_type: "authorization_code",
        code: fakeOAuthSecrets.authorizationCode,
        client_id: "https://agent.test/oauth/client-metadata.json",
        redirect_uri: "https://agent.test/oauth/callback",
        resource: "https://mcp.test.example/mcp",
      })
    );
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(exchange?.["code_verifier"])
    );
    expect(
      btoa(String.fromCodePoint(...new Uint8Array(digest)))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "")
    ).toBe(location.searchParams.get("code_challenge"));
    expect(fakeMcpServer.authorizations).toContain(
      `Bearer ${fakeOAuthSecrets.accessToken}`
    );
    expect(await pendingOAuthCountOf(ownerId)).toBe(0);
  });

  it("uses DCR when the server has no client metadata documents", async () => {
    fakeMcpServer.oauth.supportClientIdMetadata(false);
    const ownerId = await ownerWhoWroteToTheAgent(9972);
    const { state } = await startedConsent(9972, ownerId);

    const response = await goodCallback(state);

    expect(response.status).toBe(200);
    expect(fakeMcpServer.oauth.tokenRequests[0]?.["client_id"]).toBe(
      "fake-dcr-client"
    );
  });

  it("names no account when the server gives none", async () => {
    fakeMcpServer.oauth.sendAccountName(false);
    const ownerId = await ownerWhoWroteToTheAgent(9973);
    const { state } = await startedConsent(9973, ownerId);

    await goodCallback(state);

    expect(fakeTelegram.sent.at(-1)?.body.text).toBe("Connected Test server");
  });

  it("accepts a callback with no iss when the server does not promise one", async () => {
    fakeMcpServer.oauth.sendIssuer(false);
    const ownerId = await ownerWhoWroteToTheAgent(9974);
    const { state } = await startedConsent(9974, ownerId);

    const response = await callbackWith({
      code: fakeOAuthSecrets.authorizationCode,
      state,
    });

    expect(response.status).toBe(200);
    expect(await statesOf(ownerId)).toEqual([
      { catalogId: testMcpCatalogId, state: "ready" },
    ]);
  });
});

const secondConsent = async (telegramUserId: number, ownerId: string) => {
  const response = await postConsent(
    await loginOf(telegramUserId, ownerId, { authDate: nowSeconds() - 5 })
  );
  const location = await startedAuthorizationOf(response);
  return location.searchParams.get("state") ?? "";
};

describe("client authentication and tenants", () => {
  it("sends the registered client secret when the server issues one", async () => {
    fakeMcpServer.oauth.supportClientIdMetadata(false);
    fakeMcpServer.oauth.requireClientSecret(true);
    const ownerId = await ownerWhoWroteToTheAgent(9995);
    const { state } = await startedConsent(9995, ownerId);

    const response = await goodCallback(state);

    expect(response.status).toBe(200);
    expect(fakeMcpServer.oauth.tokenRequests[0]?.["client_secret"]).toBe(
      fakeOAuthSecrets.clientSecret
    );
  });

  it("sends the registered client secret in a Basic header when the server says so", async () => {
    fakeMcpServer.oauth.supportClientIdMetadata(false);
    fakeMcpServer.oauth.registerWithMethod("client_secret_basic");
    fakeMcpServer.oauth.requireClientSecret(true);
    const ownerId = await ownerWhoWroteToTheAgent(9989);
    const { state } = await startedConsent(9989, ownerId);

    const response = await goodCallback(state);

    expect(response.status).toBe(200);
    expect(
      fakeMcpServer.oauth.tokenRequests[0]?.["client_secret"]
    ).toBeUndefined();
  });

  it("refuses a registration that needs an unsupported client authentication method", async () => {
    fakeMcpServer.oauth.supportClientIdMetadata(false);
    fakeMcpServer.oauth.registerWithMethod("client_secret_jwt");
    const telegramUserId = newTelegramUserId();
    const ownerId = await ownerWhoWroteToTheAgent(telegramUserId);

    const response = await postConsent(await loginOf(telegramUserId, ownerId));

    expect(response.status).toBe(502);
    expect(await pendingOAuthCountOf(ownerId)).toBe(0);
  });

  it("posts the code to the token endpoint of a tenant issuer", async () => {
    fakeMcpServer.oauth.useLayout("challenged_tenant");
    const ownerId = await ownerWhoWroteToTheAgent(9996);
    const { state } = await startedConsent(9996, ownerId);

    const response = await callbackWith({
      code: fakeOAuthSecrets.authorizationCode,
      state,
      iss: `${issuer}/tenant1`,
    });

    expect(response.status).not.toBe(403);
    expect(fakeMcpServer.oauth.tokenRequests).toHaveLength(1);
  });
});

describe("two authorizations for one Connection", () => {
  it("refuses the second completion when the Connection is ready", async () => {
    const ownerId = await ownerWhoWroteToTheAgent(9997);
    const { state: first } = await startedConsent(9997, ownerId);
    const second = await secondConsent(9997, ownerId);

    const firstAnswer = await goodCallback(first);
    const secondAnswer = await goodCallback(second);

    expect(firstAnswer.status).toBe(200);
    expect(secondAnswer.status).toBe(200);
    expect(await secondAnswer.text()).toContain("already connected");
    expect(fakeMcpServer.oauth.tokenRequests).toHaveLength(1);
    expect(await addedEntryCountOf(ownerId)).toBe(1);
  });

  it("refuses the replay of an earlier attempt after a later one saved new tokens", async () => {
    const ownerId = await ownerWhoWroteToTheAgent(9998);
    const { state: first } = await startedConsent(9998, ownerId);
    const second = await secondConsent(9998, ownerId);
    fakeMcpServer.beUnavailable(true);

    await goodCallback(first);
    await goodCallback(second);
    fakeMcpServer.beUnavailable(false);
    const replayOfFirst = await goodCallback(first);
    const replayOfSecond = await goodCallback(second);

    expect(replayOfFirst.status).toBe(403);
    expect(replayOfSecond.status).toBe(200);
    expect(await addedEntryCountOf(ownerId)).toBe(1);
  });
});

describe("a callback that must change nothing", () => {
  it.each([
    ["a wrong nonce", (state: string) => `${state.split(".")[0]}.wrong-nonce`],
    ["no nonce", (state: string) => state.split(".")[0] ?? ""],
    [
      "an unknown routing id",
      (state: string) => `${"0".repeat(64)}.${state.split(".")[1]}`,
    ],
    [
      "a routing id of the wrong shape",
      (state: string) => `not-an-id.${state.split(".")[1]}`,
    ],
    [
      "a routing id of another namespace",
      (state: string) => `${"f".repeat(64)}.${state.split(".")[1]}`,
    ],
  ])("refuses %s", async (_name, changeState) => {
    const telegramUserId = newTelegramUserId();
    const ownerId = await ownerWhoWroteToTheAgent(telegramUserId);
    const { state } = await startedConsent(telegramUserId, ownerId);

    const response = await callbackWith({
      code: fakeOAuthSecrets.authorizationCode,
      state: changeState(state),
      iss: issuer,
    });

    expect(response.status).toBe(403);
    await expectNothingChanged(ownerId);
    expect(await pendingOAuthCountOf(ownerId)).toBe(1);
  });

  it("refuses a wrong iss and keeps the request for the good callback", async () => {
    const ownerId = await ownerWhoWroteToTheAgent(9976);
    const { state } = await startedConsent(9976, ownerId);

    const wrong = await callbackWith({
      code: fakeOAuthSecrets.authorizationCode,
      state,
      iss: "https://evil.example",
    });

    expect(wrong.status).toBe(403);
    await expectNothingChanged(ownerId);
    expect(await statusOfGoodCallback(state)).toBe(200);
  });

  it("refuses a missing iss when the server promised one", async () => {
    const ownerId = await ownerWhoWroteToTheAgent(9977);
    const { state } = await startedConsent(9977, ownerId);

    const response = await callbackWith({
      code: fakeOAuthSecrets.authorizationCode,
      state,
    });

    expect(response.status).toBe(403);
    await expectNothingChanged(ownerId);
  });

  it.each([["code"], ["error"]])(
    "refuses an empty %s and keeps the request",
    async (name) => {
      const telegramUserId = newTelegramUserId();
      const ownerId = await ownerWhoWroteToTheAgent(telegramUserId);
      const { state } = await startedConsent(telegramUserId, ownerId);

      const response = await callbackWith({ [name]: "", state, iss: issuer });

      expect(response.status).toBe(403);
      await expectNothingChanged(ownerId);
      expect(await pendingOAuthCountOf(ownerId)).toBe(1);
    }
  );

  it("refuses a callback with no code and no error", async () => {
    const ownerId = await ownerWhoWroteToTheAgent(9978);
    const { state } = await startedConsent(9978, ownerId);

    const response = await callbackWith({ state, iss: issuer });

    expect(response.status).toBe(403);
    await expectNothingChanged(ownerId);
  });
});

describe("a callback that fails after the nonce is used", () => {
  it("marks the Connection failed when the Owner refuses at the provider", async () => {
    const ownerId = await ownerWhoWroteToTheAgent(9979);
    const { state } = await startedConsent(9979, ownerId);

    const response = await callbackWith({
      error: "access_denied",
      state,
      iss: issuer,
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("did not finish");
    expect(fakeMcpServer.oauth.tokenRequests).toEqual([]);
    expect(await statesOf(ownerId)).toEqual([
      { catalogId: testMcpCatalogId, state: "failed" },
    ]);
    expect(await statusOfGoodCallback(state)).toBe(403);
  });

  it("logs the phase and the HTTP status of a refused code, with no secret", async () => {
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...parts) => {
      lines.push(parts.map(String).join(" "));
    });
    fakeMcpServer.oauth.refuseCodes(true);
    const telegramUserId = newTelegramUserId();
    const ownerId = await ownerWhoWroteToTheAgent(telegramUserId);
    const { state } = await startedConsent(telegramUserId, ownerId);

    await goodCallback(state);
    log.mockRestore();

    const failures = lines.filter((line) => line.includes("MCP failure"));
    expect(failures.join("\n")).toContain(
      '"phase":"token_exchange","catalogId":"test_server","reason":"refused","httpStatus":400'
    );
    expect(failures.join("\n")).toContain(
      '"phase":"callback","reason":"outcome_failed"'
    );
    for (const secret of Object.values(fakeOAuthSecrets)) {
      expect(lines.join("\n")).not.toContain(secret);
    }
  });

  it("marks the Connection failed when the token endpoint refuses the code", async () => {
    fakeMcpServer.oauth.refuseCodes(true);
    const ownerId = await ownerWhoWroteToTheAgent(9980);
    const { state } = await startedConsent(9980, ownerId);

    const response = await goodCallback(state);

    expect(response.status).toBe(502);
    expect(await statesOf(ownerId)).toEqual([
      { catalogId: testMcpCatalogId, state: "failed" },
    ]);
    expect(await journalTagsOf(ownerId)).not.toContain("McpConnectionAdded");
    expect(await statusOfGoodCallback(state)).toBe(403);
    expect(fakeMcpServer.oauth.tokenRequests).toHaveLength(1);
  });
});

describe("a replay of a good callback", () => {
  it("settles with the first tokens and makes no second Connection", async () => {
    const ownerId = await ownerWhoWroteToTheAgent(9981);
    const { state } = await startedConsent(9981, ownerId);

    const first = await goodCallback(state);
    const second = await goodCallback(state);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.text()).toContain("Test server is connected");
    expect(fakeMcpServer.oauth.tokenRequests).toHaveLength(1);
    expect(await addedEntryCountOf(ownerId)).toBe(1);
    expect(fakeTelegram.sent).toHaveLength(2);
    expect(await statesOf(ownerId)).toEqual([
      { catalogId: testMcpCatalogId, state: "ready" },
    ]);
  });

  it("finishes with the saved tokens when the first connect failed", async () => {
    const ownerId = await ownerWhoWroteToTheAgent(9990);
    const { state } = await startedConsent(9990, ownerId);
    fakeMcpServer.beUnavailable(true);

    const first = await goodCallback(state);
    fakeMcpServer.beUnavailable(false);
    const wrongIssuer = await callbackWith({
      code: fakeOAuthSecrets.authorizationCode,
      state,
      iss: "https://evil.example",
    });
    expect(await statesOf(ownerId)).toEqual([
      { catalogId: testMcpCatalogId, state: "failed" },
    ]);
    const second = await goodCallback(state);

    expect(first.status).toBe(502);
    expect(wrongIssuer.status).toBe(403);
    expect(second.status).toBe(200);
    expect(fakeMcpServer.oauth.tokenRequests).toHaveLength(1);
    expect(await statesOf(ownerId)).toEqual([
      { catalogId: testMcpCatalogId, state: "ready" },
    ]);
    expect(await addedEntryCountOf(ownerId)).toBe(1);
    expect(fakeTelegram.sent.at(-1)?.body.text).toBe(
      "Connected Test server (account Pat Reader)"
    );
  });

  it("sends one message, writes one Journal Entry, and sets ready when the Personal Agent hears the same completion twice", async () => {
    const ownerId = await ownerWhoWroteToTheAgent(9991);
    const agent = await agentOf(ownerId);
    const completion = {
      catalogId: testMcpCatalogId,
      tools: [],
      accountLabel: undefined,
      completionId: "completion-1",
    };

    await agent.receiveMcpConnected(completion);
    await agent.receiveMcpConnectionState(testMcpCatalogId, "failed");
    await agent.receiveMcpConnected(completion);

    expect(await statesOf(ownerId)).toEqual([
      { catalogId: testMcpCatalogId, state: "ready" },
    ]);

    expect(await addedEntryCountOf(ownerId)).toBe(1);
    expect(fakeTelegram.sent).toHaveLength(2);
  });

  it("lets a replay deliver the completion when the hub stopped after it recorded the Connection", async () => {
    const ownerId = await ownerWhoWroteToTheAgent(9988);
    const { state } = await startedConsent(9988, ownerId);
    fakeMcpServer.beUnavailable(true);
    await goodCallback(state);
    fakeMcpServer.beUnavailable(false);
    await runInDurableObject(
      env.MCP_HUB.getByName(ownerId),
      (_instance, { storage }) =>
        storage.put(`connection:${testMcpCatalogId}`, true)
    );

    const replay = await goodCallback(state);

    expect(replay.status).toBe(200);
    expect(await statesOf(ownerId)).toEqual([
      { catalogId: testMcpCatalogId, state: "ready" },
    ]);
    expect(await addedEntryCountOf(ownerId)).toBe(1);
  });

  it("does not deliver the completion of an earlier attempt after a later attempt exchanged its code", async () => {
    const ownerId = await ownerWhoWroteToTheAgent(9968);
    const { state: first } = await startedConsent(9968, ownerId);
    const second = await secondConsent(9968, ownerId);
    fakeMcpServer.beUnavailable(true);
    await goodCallback(first);
    fakeMcpServer.beUnavailable(false);
    const releaseExchange = fakeMcpServer.oauth.holdTokenRequests();

    const laterAttempt = goodCallback(second);
    await vi.waitFor(() =>
      expect(fakeMcpServer.oauth.tokenRequests).toHaveLength(2)
    );
    const earlierReplay = goodCallback(first);
    await vi.waitFor(async () =>
      expect(await completionsWaitingOf(ownerId)).toBe(1)
    );
    releaseExchange();
    const [later, earlier] = await Promise.all([laterAttempt, earlierReplay]);

    expect(later.status).toBe(200);
    expect(earlier.status).toBe(403);
    expect(await addedEntryCountOf(ownerId)).toBe(1);
    expect(await statesOf(ownerId)).toEqual([
      { catalogId: testMcpCatalogId, state: "ready" },
    ]);
  });

  it("connects a second authorization with its own tokens after the completion failed once", async () => {
    fakeMcpServer.oauth.issueFreshTokens(true);
    fakeMcpServer.oauth.requireToken(true);
    const ownerId = await ownerWhoWroteToTheAgent(9967);
    const { state: first } = await startedConsent(9967, ownerId);
    const second = await secondConsent(9967, ownerId);
    fakeCompletion.failures = 1;

    const failed = await goodCallback(first);
    const connected = await goodCallback(second);

    expect(failed.status).toBe(502);
    expect(connected.status).toBe(200);
    expect(fakeMcpServer.authorizations.at(-1)).toBe(
      `Bearer ${fakeOAuthSecrets.accessToken}-2`
    );
    expect(await statesOf(ownerId)).toEqual([
      { catalogId: testMcpCatalogId, state: "ready" },
    ]);
    expect(await addedEntryCountOf(ownerId)).toBe(1);
  });

  it("ends ready when the completion committed and its result was lost", async () => {
    const ownerId = await ownerWhoWroteToTheAgent(9966);
    const { state } = await startedConsent(9966, ownerId);
    fakeCompletion.failuresAfterCommit = 1;

    const lost = await goodCallback(state);
    expect(await statesOf(ownerId)).toEqual([
      { catalogId: testMcpCatalogId, state: "failed" },
    ]);
    const replay = await goodCallback(state);

    expect(lost.status).toBe(502);
    expect(replay.status).toBe(200);
    expect(await statesOf(ownerId)).toEqual([
      { catalogId: testMcpCatalogId, state: "ready" },
    ]);
    expect(await addedEntryCountOf(ownerId)).toBe(1);
    expect(fakeTelegram.sent).toHaveLength(2);
  });

  it("does not let a second start overwrite ready after the first callback completed", async () => {
    const ownerId = await ownerWhoWroteToTheAgent(9965);
    const { state: first } = await startedConsent(9965, ownerId);
    const releaseDiscovery = fakeMcpServer.oauth.holdMetadataRequests();

    const secondStart = postConsent(
      await loginOf(9965, ownerId, { authDate: nowSeconds() - 5 })
    );
    await vi.waitFor(() =>
      expect(fakeMcpServer.oauth.heldMetadataRequests).toBeGreaterThan(0)
    );
    const completed = await goodCallback(first);
    expect(await statesOf(ownerId)).toEqual([
      { catalogId: testMcpCatalogId, state: "ready" },
    ]);
    releaseDiscovery();
    const started = await secondStart;

    expect(completed.status).toBe(200);
    expect(started.status).toBe(200);
    expect(await started.text()).toContain("already connected");
    expect(await statesOf(ownerId)).toEqual([
      { catalogId: testMcpCatalogId, state: "ready" },
    ]);
    expect(await pendingOAuthCountOf(ownerId)).toBe(0);
  });

  it("serializes two completions of one entry so only one exchanges a code", async () => {
    const ownerId = await ownerWhoWroteToTheAgent(9987);
    const { state: first } = await startedConsent(9987, ownerId);
    const second = await secondConsent(9987, ownerId);

    const answers = await Promise.all([
      goodCallback(first),
      goodCallback(second),
    ]);

    expect(answers.map(({ status }) => status)).toEqual([200, 200]);
    expect(fakeMcpServer.oauth.tokenRequests).toHaveLength(1);
  });

  it("makes one Journal Entry for two completions that arrive together", async () => {
    const ownerId = await ownerWhoWroteToTheAgent(9999);
    const agent = await agentOf(ownerId);
    const completion = {
      catalogId: testMcpCatalogId,
      tools: [],
      accountLabel: undefined,
      completionId: "completion-2",
    };

    await Promise.all([
      agent.receiveMcpConnected(completion),
      agent.receiveMcpConnected(completion),
    ]);

    expect(await addedEntryCountOf(ownerId)).toBe(1);
    expect(fakeTelegram.sent).toHaveLength(2);
  });

  it("keeps the Connection ready when the Owner chat cannot be read after the completion is stored", async () => {
    const ownerId = await ownerWhoWroteToTheAgent(9969);
    const { state } = await startedConsent(9969, ownerId);
    await runInDurableObject(await agentOf(ownerId), (_instance, { storage }) =>
      storage.sql.exec("DROP TABLE owner_channel_conversations")
    );

    const response = await goodCallback(state);

    expect(response.status).toBe(200);
    expect(await statesOf(ownerId)).toEqual([
      { catalogId: testMcpCatalogId, state: "ready" },
    ]);
    expect(await addedEntryCountOf(ownerId)).toBe(1);
  });

  it("keeps the Connection ready when the Connected message cannot be sent", async () => {
    const ownerId = await ownerWhoWroteToTheAgent(9994);
    const { state } = await startedConsent(9994, ownerId);
    fakeTelegram.refuseFromSend(1);

    const response = await goodCallback(state);

    expect(response.status).toBe(200);
    expect(await statesOf(ownerId)).toEqual([
      { catalogId: testMcpCatalogId, state: "ready" },
    ]);
    expect(await addedEntryCountOf(ownerId)).toBe(1);
  });

  it("does not share a running callback with one that has a wrong iss", async () => {
    const ownerId = await ownerWhoWroteToTheAgent(9992);
    const { state } = await startedConsent(9992, ownerId);

    const [good, wrong] = await Promise.all([
      goodCallback(state),
      callbackWith({
        code: fakeOAuthSecrets.authorizationCode,
        state,
        iss: "https://evil.example",
      }),
    ]);

    expect(good.status).toBe(200);
    expect(wrong.status).toBe(403);
    expect(fakeMcpServer.oauth.tokenRequests).toHaveLength(1);
  });

  it("shares one run between a callback with iss and one without when the server promised none", async () => {
    fakeMcpServer.oauth.sendIssuer(false);
    const ownerId = await ownerWhoWroteToTheAgent(9993);
    const { state } = await startedConsent(9993, ownerId);

    const answers = await Promise.all([
      goodCallback(state),
      callbackWith({ code: fakeOAuthSecrets.authorizationCode, state }),
    ]);

    expect(answers.map(({ status }) => status)).toEqual([200, 200]);
    expect(fakeMcpServer.oauth.tokenRequests).toHaveLength(1);
  });

  it("makes one token request for two callbacks at the same time", async () => {
    const ownerId = await ownerWhoWroteToTheAgent(9982);
    const { state } = await startedConsent(9982, ownerId);

    const answers = await Promise.all([
      goodCallback(state),
      goodCallback(state),
    ]);

    expect(answers.map(({ status }) => status)).toEqual([200, 200]);
    expect(fakeMcpServer.oauth.tokenRequests).toHaveLength(1);
    expect(await addedEntryCountOf(ownerId)).toBe(1);
  });
});

describe("the sealed token store", () => {
  it("keeps no token, client secret, code, or verifier in plain text after a full connect", async () => {
    fakeMcpServer.oauth.supportClientIdMetadata(false);
    fakeMcpServer.oauth.requireToken(true);
    const ownerId = await ownerWhoWroteToTheAgent(9983);
    const { state } = await startedConsent(9983, ownerId);
    await goodCallback(state);
    const verifier = fakeMcpServer.oauth.tokenRequests[0]?.["code_verifier"];
    expect(verifier).toBeDefined();

    const stored = await everythingStoredFor(ownerId);

    expect(stored).toContain("tokens:test_server");
    const secrets = [...Object.values(fakeOAuthSecrets), verifier ?? ""];
    for (const secret of secrets) {
      expect(stored).not.toContain(secret);
      expect(logged.lines.join("\n")).not.toContain(secret);
    }
  });

  it("opens a sealed record only for its own Owner and Connection", async () => {
    const ownerId = await ownerWhoWroteToTheAgent(9984);
    const { state } = await startedConsent(9984, ownerId);
    await goodCallback(state);
    const keyring = await parseSealKeyring(env.MCP_SEALING_KEYS);

    await runInDurableObject(
      env.MCP_HUB.getByName(ownerId),
      async (_instance, { storage }) => {
        const own = new SealedCredentials(storage, keyring, ownerId);
        const opened = await own.tokens(testMcpCatalogId);
        expect(opened?.access_token).toBe(fakeOAuthSecrets.accessToken);
        const sealed = await storage.get<string>(`tokens:${testMcpCatalogId}`);
        await storage.put("tokens:other_server", sealed);
        await expect(own.tokens("other_server")).rejects.toThrow();
        const stranger = new SealedCredentials(
          storage,
          keyring,
          "another-owner"
        );
        await expect(stranger.tokens(testMcpCatalogId)).rejects.toThrow();
      }
    );
  });

  it("opens a record that an older key sealed after a rotation", async () => {
    const ownerId = await ownerWhoWroteToTheAgent(9985);
    const { state } = await startedConsent(9985, ownerId);
    await goodCallback(state);
    const rotated = await parseSealKeyring(
      `test-2:BwYFBAMCAQAPDg0MCwoJCBcWFRQTEhEQHx4dHBsaGRg=,${env.MCP_SEALING_KEYS}`
    );

    await runInDurableObject(
      env.MCP_HUB.getByName(ownerId),
      async (_instance, { storage }) => {
        const credentials = new SealedCredentials(storage, rotated, ownerId);
        const opened = await credentials.tokens(testMcpCatalogId);
        expect(opened?.refresh_token).toBe(fakeOAuthSecrets.refreshToken);
      }
    );
  });

  it("keeps the old refresh token when a refresh brings no new one", async () => {
    const ownerId = await ownerWhoWroteToTheAgent(9986);
    const { state } = await startedConsent(9986, ownerId);
    await goodCallback(state);
    const keyring = await parseSealKeyring(env.MCP_SEALING_KEYS);

    await runInDurableObject(
      env.MCP_HUB.getByName(ownerId),
      async (_instance, { storage }) => {
        const credentials = new SealedCredentials(storage, keyring, ownerId);
        await credentials.saveTokens(testMcpCatalogId, {
          access_token: "next-access-token",
          token_type: "Bearer",
        });
        expect(await credentials.tokens(testMcpCatalogId)).toEqual(
          expect.objectContaining({
            access_token: "next-access-token",
            refresh_token: fakeOAuthSecrets.refreshToken,
          })
        );
      }
    );
  });
});

describe("the sealing key list", () => {
  it.each([
    [
      "a key id that is listed twice",
      `a:${"A".repeat(43)}=,a:${"B".repeat(43)}=`,
    ],
    ["a key of the wrong length", `a:${"A".repeat(20)}=`],
    ["an entry with no key id", `:${"A".repeat(43)}=`],
    ["an empty list", " , "],
  ])("refuses %s", async (_name, secret) => {
    await expect(parseSealKeyring(secret)).rejects.toThrow();
  });
});

describe("OAuth metadata that points to a refused address", () => {
  it.each([
    ["a private address", "https://10.0.0.5/token"],
    ["an http address", "http://mcp.test.example/token"],
  ])("refuses a token endpoint at %s", async (_name, endpoint) => {
    fakeMcpServer.oauth.useTokenEndpoint(endpoint);
    const telegramUserId = newTelegramUserId();
    const ownerId = await ownerWhoWroteToTheAgent(telegramUserId);

    const response = await postConsent(await loginOf(telegramUserId, ownerId));

    expect(response.status).toBe(502);
    expect(await pendingOAuthCountOf(ownerId)).toBe(0);
  });
});
