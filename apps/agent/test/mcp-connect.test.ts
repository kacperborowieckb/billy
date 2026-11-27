import { env, runInDurableObject } from "cloudflare:test";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { McpConnections } from "../src/mcp/mcp-connections.ts";
import { testMcpCatalogId } from "../src/mcp/mcp-test-catalog.ts";
import { connectMcpServerToolName } from "../src/mcp/mcp-tool-names.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import {
  fakeMcpServer,
  fakeTelegram,
  mcpHubWakes,
  resetFakes,
  scriptModel,
} from "./fakes.ts";
import {
  getConsent,
  loginOf,
  nowSeconds,
  pendingOAuthCountOf,
  pendingOAuthOf,
  postConsent,
} from "./mcp-connect-requests.ts";
import {
  addOwner,
  sendToEdge,
  telegramWebhook,
  textUpdate,
} from "./telegram-requests.ts";

const statesOf = async (ownerId: string) =>
  runInDurableObject(
    await personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId)),
    (agent) =>
      agent.runtime.runPromise(
        McpConnections.pipe(Effect.flatMap((connections) => connections.states))
      )
  );

beforeEach(() => {
  resetFakes();
});

describe("the Connect button", () => {
  it("sends a login_url button that code writes, with no link from the model", async () => {
    const ownerId = await addOwner(9951);
    scriptModel([
      {
        callTool: connectMcpServerToolName,
        input: { connection: testMcpCatalogId },
      },
      { say: "Tap the button below." },
    ]);

    await telegramWebhook(
      textUpdate({ fromUserId: 9951, text: "connect the test server" })
    );
    await vi.waitFor(() =>
      expect(fakeTelegram.sent.length).toBeGreaterThanOrEqual(2)
    );

    const [reply, button] = fakeTelegram.sent;
    expect(reply?.body.text).toBe("Tap the button below.");
    expect(reply?.body.reply_markup).toBeUndefined();
    expect(button?.url).toBe(
      "https://telegram.fake/bottest-telegram-bot-token/sendMessage"
    );
    expect(button?.body).toEqual({
      chat_id: 9951,
      text: "Connect Test server",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "Connect Test server",
              login_url: {
                url: `https://edge.test.example/mcp/connect?c=test_server&r=${env.MCP_HUB.idFromName(ownerId).toString()}`,
              },
            },
          ],
        ],
      },
    });
  });
});

describe("the consent page", () => {
  it("shows the page to the Owner and starts nothing on a GET", async () => {
    const ownerId = await addOwner(9952);
    const wakes = mcpHubWakes.count;

    const response = await getConsent(await loginOf(9952, ownerId));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Test server");
    expect(html).toContain("https://mcp.test.example");
    expect(html).toContain("CIMD");
    expect(html).toContain('method="post"');
    expect(await pendingOAuthCountOf(ownerId)).toBe(0);
    expect(await statesOf(ownerId)).toEqual([]);
    expect(mcpHubWakes.count).toBeGreaterThanOrEqual(wakes);
  });

  it.each([
    ["another Telegram account", (ownerId) => loginOf(9999, ownerId)],
    [
      "a bad signature",
      async (ownerId: string) => {
        const params = await loginOf(9953, ownerId);
        params.set("hash", "0".repeat(64));
        return params;
      },
    ],
    [
      "a signature made with another bot token",
      (ownerId) => loginOf(9953, ownerId, { botToken: "another-bot" }),
    ],
    [
      "an old auth_date",
      (ownerId) => loginOf(9953, ownerId, { authDate: nowSeconds() - 3600 }),
    ],
  ])("refuses %s and starts nothing", async (_name, makeParams) => {
    const ownerId = await addOwner(9953);
    const wakes = mcpHubWakes.count;
    const params = await makeParams(ownerId);

    const getAnswer = await getConsent(params);
    const postAnswer = await postConsent(params);

    expect(getAnswer.status).toBe(403);
    expect(postAnswer.status).toBe(403);
    expect(postAnswer.headers.get("Location")).toBeNull();
    expect(mcpHubWakes.count).toBe(wakes);
    expect(await pendingOAuthCountOf(ownerId)).toBe(0);
    expect(fakeMcpServer.oauth.registrations).toEqual([]);
  });
});

describe("a forwarded button or link", () => {
  it("refuses another registered Owner and starts nothing", async () => {
    const ownerId = await addOwner(9958);
    const otherOwnerId = await addOwner(9959);
    const params = await loginOf(9959, ownerId);

    const getAnswer = await getConsent(params);
    const postAnswer = await postConsent(params);

    expect(getAnswer.status).toBe(403);
    expect(postAnswer.status).toBe(403);
    expect(await pendingOAuthCountOf(ownerId)).toBe(0);
    expect(await pendingOAuthCountOf(otherOwnerId)).toBe(0);
  });

  it("refuses a login with two hash fields", async () => {
    const ownerId = await addOwner(9963);
    const valid = await loginOf(9963, ownerId);
    const doubled = new URLSearchParams([
      ["hash", "0".repeat(64)],
      ...valid.entries(),
    ]);

    const response = await postConsent(doubled);

    expect(response.status).toBe(403);
    expect(await pendingOAuthCountOf(ownerId)).toBe(0);
  });

  it("uses up the login proof at the first POST", async () => {
    const ownerId = await addOwner(9960);
    const params = await loginOf(9960, ownerId);

    const first = await postConsent(params);
    const second = await postConsent(params);

    const shouted = new URLSearchParams(params);
    shouted.set("hash", (params.get("hash") ?? "").toUpperCase());
    const third = await postConsent(shouted);

    expect(first.status).toBe(303);
    expect(second.status).toBe(403);
    expect(third.status).toBe(403);
    expect(second.headers.get("Location")).toBeNull();
    expect(await pendingOAuthCountOf(ownerId)).toBe(1);
  });
});

describe("discovering the authorization server", () => {
  it("follows the resource_metadata challenge to a tenant issuer", async () => {
    const ownerId = await addOwner(9961);
    fakeMcpServer.oauth.useLayout("challenged_tenant");

    const response = await postConsent(await loginOf(9961, ownerId));

    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("Location") ?? "");
    expect(location.pathname).toBe("/tenant1/authorize");
  });

  it("uses well-known metadata when the challenged metadata cannot be decoded", async () => {
    const ownerId = await addOwner(9965);
    fakeMcpServer.oauth.useLayout("invalid_challenge");

    const response = await postConsent(await loginOf(9965, ownerId));

    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("Location") ?? "");
    expect(location.pathname).toBe("/authorize");
  });

  it("finishes discovery when metadata endpoints send headers and never end the body", async () => {
    const ownerId = await addOwner(9966);
    fakeMcpServer.oauth.useLayout("hanging_metadata");

    const response = await postConsent(await loginOf(9966, ownerId));

    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("Location") ?? "");
    expect(location.pathname).toBe("/authorize");
  }, 15_000);

  it("registers a client at the tenant registration endpoint", async () => {
    const ownerId = await addOwner(9964);
    fakeMcpServer.oauth.useLayout("challenged_tenant");
    fakeMcpServer.oauth.supportClientIdMetadata(false);

    const response = await postConsent(await loginOf(9964, ownerId));

    expect(response.status).toBe(303);
    expect(fakeMcpServer.oauth.registrations).toHaveLength(1);
  });

  it("refuses metadata whose issuer is not the selected issuer", async () => {
    const ownerId = await addOwner(9962);
    fakeMcpServer.oauth.useLayout("root_metadata_only");

    const response = await postConsent(await loginOf(9962, ownerId));

    expect(response.status).toBe(502);
    expect(await pendingOAuthCountOf(ownerId)).toBe(0);
  });
});

describe("starting OAuth from the consent page", () => {
  it("redirects to the authorization server with PKCE S256 and a state without the Owner", async () => {
    const ownerId = await addOwner(9954);

    const response = await postConsent(await loginOf(9954, ownerId));

    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("Location") ?? "");
    expect(location.origin + location.pathname).toBe(
      "https://mcp.test.example/authorize"
    );
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("client_id")).toBe(
      "https://agent.test/oauth/client-metadata.json"
    );
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://agent.test/oauth/callback"
    );
    const state = location.searchParams.get("state") ?? "";
    const [routingId, nonce] = state.split(".");
    expect(routingId).toBe(env.MCP_HUB.idFromName(ownerId).toString());
    expect(state).not.toContain(ownerId);
    expect(state).not.toContain("telegram");
    expect(state).not.toContain("9954");
    const pending = await pendingOAuthOf(ownerId);
    expect([...pending.keys()]).toEqual([`oauth:${nonce}`]);
    const stored = pending.get(`oauth:${nonce}`) as {
      sealedCodeVerifier: string;
    };
    expect(stored.sealedCodeVerifier).toMatch(/^v1\.test-1\./u);
    expect(location.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/u);
    expect(await statesOf(ownerId)).toEqual([
      { catalogId: testMcpCatalogId, state: "authenticating" },
    ]);
  });

  it("registers a client when the server has no client metadata documents", async () => {
    const ownerId = await addOwner(9955);
    fakeMcpServer.oauth.supportClientIdMetadata(false);

    const response = await postConsent(await loginOf(9955, ownerId));

    const location = new URL(response.headers.get("Location") ?? "");
    expect(location.searchParams.get("client_id")).toBe("fake-dcr-client");
    expect(fakeMcpServer.oauth.registrations).toEqual([
      expect.objectContaining({
        redirect_uris: ["https://agent.test/oauth/callback"],
        token_endpoint_auth_method: "none",
      }),
    ]);
  });

  it("starts nothing when the authorization server has no PKCE S256", async () => {
    const ownerId = await addOwner(9956);
    fakeMcpServer.oauth.supportPkce(false);

    const response = await postConsent(await loginOf(9956, ownerId));

    expect(response.status).toBe(502);
    expect(await pendingOAuthCountOf(ownerId)).toBe(0);
    expect(await statesOf(ownerId)).toEqual([]);
  });

  it("answers 404 for a service that the catalog does not list", async () => {
    const ownerId = await addOwner(9957);
    const params = await loginOf(9957, ownerId);
    params.set("c", "unknown");

    const response = await postConsent(params);

    expect(response.status).toBe(404);
  });
});

describe("the client metadata document", () => {
  it("is served on HTTPS", async () => {
    const response = await sendToEdge(
      new Request("https://agent.test/oauth/client-metadata.json")
    );

    expect(await response.json()).toEqual(
      expect.objectContaining({
        client_id: "https://agent.test/oauth/client-metadata.json",
        redirect_uris: ["https://agent.test/oauth/callback"],
      })
    );
  });

  it("does not exist on plain HTTP", async () => {
    const response = await sendToEdge(
      new Request("http://localhost/oauth/client-metadata.json")
    );

    expect(response.status).toBe(404);
  });
});
