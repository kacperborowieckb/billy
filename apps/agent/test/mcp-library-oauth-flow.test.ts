import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakeOAuthSecrets } from "../control/fake-oauth-server.ts";
import { fakeMcpServer, resetFakes } from "./fakes.ts";
import {
  callbackUrl,
  clientMetadataUrl,
  inLibraryHost,
} from "./mcp-library-oauth-host.ts";
import type { HostOptions, LibraryHost } from "./mcp-library-oauth-host.ts";

const { oauth } = fakeMcpServer;

const issuer = "https://mcp.test.example";

const shortDeadline: HostOptions = { oauthDeadlineMillis: 200 };

const slowTest = 30_000;

beforeEach(() => {
  resetFakes();
  oauth.issueFreshTokens(true);
  oauth.requireToken(true);
});

const goodQuery = (state: string) => ({
  code: fakeOAuthSecrets.authorizationCode,
  state,
  iss: issuer,
});

const connected = async (host: LibraryHost) => {
  await host.register();
  const started = await host.startAuthorization();
  const result = await host.callback(goodQuery(started.state));
  expect(result.authSuccess).toBe(true);
  await host.establish();
  return started;
};

const exchangeCount = () =>
  oauth.tokenRequests.filter(
    (request) => request["grant_type"] === "authorization_code"
  ).length;

const unauthorized = expect.objectContaining({ name: "UnauthorizedError" });

const twoOverlappingRefreshes = async (host: LibraryHost) => {
  await connected(host);
  oauth.expireAccessToken();
  const releaseFirst = oauth.holdTokenRequests();
  const first = host.search();
  await vi.waitFor(() => expect(oauth.refreshRequests).toHaveLength(1));
  const releaseSecond = oauth.holdTokenRequests();
  const second = Promise.allSettled([host.search()]);
  await vi.waitFor(() => expect(oauth.refreshRequests).toHaveLength(2));
  releaseFirst();
  await first;
  releaseSecond();
  const [settled] = await second;
  return settled;
};

describe("the library flow over the sealing storage", () => {
  it(
    "connects the fake MCP server and stores no plain value",
    () =>
      inLibraryHost(async (host) => {
        const { authorizationUrl, state } = await connected(host);

        expect(state).toMatch(/^[\w-]+\.test_server$/u);
        expect(Object.fromEntries(authorizationUrl.searchParams)).toEqual(
          expect.objectContaining({
            client_id: clientMetadataUrl,
            code_challenge_method: "S256",
            redirect_uri: callbackUrl,
            resource: `${issuer}/mcp`,
          })
        );
        expect(oauth.registrations).toHaveLength(0);
        expect(oauth.tokenRequests[0]).toHaveProperty("code_verifier");
        expect(await host.search()).toHaveProperty("content");

        const records = await host.storedOAuthRecords();
        expect(records.length).toBeGreaterThan(0);
        expect(records.every((record) => record.startsWith("v1."))).toBe(true);
        expect(records.join("\n")).not.toContain("fake-");
        const tokens = await host.storedTokens();
        expect(tokens?.refresh_token).toBe(fakeOAuthSecrets.refreshToken);
        expect(tokens).not.toHaveProperty("account_name");
      }),
    slowTest
  );

  it.each(["client_secret_post", "client_secret_basic"])(
    "registers with DCR and sends the returned secret with %s",
    (method) => {
      oauth.supportClientIdMetadata(false);
      oauth.requireClientSecret(true);
      oauth.registerWithMethod(method);
      return inLibraryHost(async (host) => {
        await connected(host);
        oauth.expireAccessToken();

        expect(await host.search()).toHaveProperty("content");
        expect(oauth.registrations).toEqual([
          expect.objectContaining({ token_endpoint_auth_method: "none" }),
        ]);
        const records = await host.storedOAuthRecords();
        expect(records.join("\n")).not.toContain(fakeOAuthSecrets.clientSecret);
      });
    },
    slowTest
  );

  it(
    "registers again when the client id is not given again",
    () => {
      oauth.supportClientIdMetadata(false);
      return inLibraryHost(async (host) => {
        await connected(host);
        await host.forgetConnection();
        await host.register("");
        await host.connect();

        expect(oauth.registrations).toHaveLength(2);
      });
    },
    slowTest
  );
});

describe("a refresh by the library", () => {
  it(
    "makes one token request for each call that needs it",
    () =>
      inLibraryHost(async (host) => {
        const second = await twoOverlappingRefreshes(host);

        expect(second.status).toBe("fulfilled");
        expect(oauth.refreshRequests).toHaveLength(2);
      }),
    slowTest
  );

  it(
    "deletes a rotated token when an older refresh is refused later",
    () => {
      oauth.rotateRefreshTokens(true);
      return inLibraryHost(async (host) => {
        const second = await twoOverlappingRefreshes(host);

        expect(second).toEqual({ status: "rejected", reason: unauthorized });
        expect(await host.storedTokens()).toBeUndefined();
      });
    },
    slowTest
  );

  it(
    "keeps the tokens but asks for a sign-in when the token endpoint is down",
    () =>
      inLibraryHost(async (host) => {
        await connected(host);
        oauth.expireAccessToken();
        oauth.failRefreshesWith(503);

        await expect(host.search()).rejects.toEqual(unauthorized);
        expect(await host.storedTokens()).toHaveProperty("refresh_token");

        oauth.failRefreshesWith(undefined);
        expect(await host.search()).toHaveProperty("content");
      }),
    slowTest
  );

  it(
    "deletes the tokens after a rotated refresh token was lost",
    () => {
      oauth.rotateRefreshTokens(true);
      return inLibraryHost(async (host) => {
        await connected(host);
        oauth.expireAccessToken();
        oauth.cutRefreshResponseBodies(true);
        await expect(host.search()).rejects.toEqual(unauthorized);
        expect(await host.storedTokens()).toHaveProperty("refresh_token");

        oauth.cutRefreshResponseBodies(false);
        await expect(host.search()).rejects.toEqual(unauthorized);
        expect(await host.storedTokens()).toBeUndefined();
      }, shortDeadline);
    },
    slowTest
  );

  it(
    "asks for a sign-in when the server demands more scope",
    () =>
      inLibraryHost(async (host) => {
        await connected(host);
        fakeMcpServer.demandMoreScope(true);

        await expect(host.search()).rejects.toEqual(unauthorized);
        expect(oauth.refreshRequests).toHaveLength(0);
      }),
    slowTest
  );

  it(
    "can report a demand for more scope as its own error",
    () =>
      inLibraryHost(
        async (host) => {
          await connected(host);
          fakeMcpServer.demandMoreScope(true);

          await expect(host.search()).rejects.toEqual(
            expect.objectContaining({ name: "InsufficientScopeError" })
          );
        },
        { onInsufficientScope: "throw" }
      ),
    slowTest
  );
});

describe("a callback to the library", () => {
  it.each([
    ["a wrong", { iss: "https://attacker.example" }],
    ["no", {}],
  ])(
    "refuses %s iss and uses up the state",
    (_, issuerQuery) =>
      inLibraryHost(async (host) => {
        await host.register();
        const { state } = await host.startAuthorization();

        const forged = await host.callback({
          code: fakeOAuthSecrets.authorizationCode,
          state,
          ...issuerQuery,
        });
        const real = await host.callback(goodQuery(state));

        expect(forged.authSuccess).toBe(false);
        expect(real.authSuccess).toBe(false);
        expect(exchangeCount()).toBe(0);
      }),
    slowTest
  );

  it(
    "ignores an unknown state and keeps the pending request",
    () =>
      inLibraryHost(async (host) => {
        await host.register();
        const { state } = await host.startAuthorization();

        const forged = await host.callback(goodQuery("unknown.test_server"));
        const real = await host.callback(goodQuery(state));

        expect(forged.authSuccess).toBe(false);
        expect(real.authSuccess).toBe(true);
      }),
    slowTest
  );

  it(
    "exchanges one time and reports success for any later callback",
    () =>
      inLibraryHost(async (host) => {
        await host.register();
        const { state } = await host.startAuthorization();

        const together = await Promise.all([
          host.callback(goodQuery(state)),
          host.callback(goodQuery(state)),
        ]);
        await host.establish();
        const replay = await host.callback(goodQuery(state));
        const unknown = await host.callback(goodQuery("unknown.test_server"));

        expect(
          [...together, replay, unknown].map((result) => result.authSuccess)
        ).toEqual([true, true, true, true]);
        expect(exchangeCount()).toBe(1);
      }),
    slowTest
  );

  it(
    "replaces the tokens with a second callback after one failed refresh",
    () =>
      inLibraryHost(async (host) => {
        await host.register();
        const older = await host.startAuthorization();
        const newer = await host.startAuthorization();
        await host.callback(goodQuery(newer.state));
        await host.establish();
        const first = await host.storedTokens();

        await host.forgetConnection();
        await host.register();
        oauth.expireAccessToken();
        oauth.failRefreshesWith(503);
        expect(await host.connect()).toHaveProperty("state", "authenticating");
        oauth.failRefreshesWith(undefined);
        const second = await host.callback(goodQuery(older.state));

        expect(second.authSuccess).toBe(true);
        expect(exchangeCount()).toBe(2);
        const replaced = await host.storedTokens();
        expect(replaced?.access_token).not.toBe(first?.access_token);
      }),
    slowTest
  );

  it(
    "finds no connection for a callback after the connection is gone",
    () =>
      inLibraryHost(async (host) => {
        await host.register();
        const { state } = await host.startAuthorization();
        await host.forgetConnection();

        const result = await host.callback(goodQuery(state));

        expect(result.authSuccess).toBe(false);
        expect(exchangeCount()).toBe(0);
      }),
    slowTest
  );

  it(
    "reports success with no exchange for a connection that did not connect",
    () =>
      inLibraryHost(async (host) => {
        await host.register();
        const { state } = await host.startAuthorization();
        await host.forgetConnection();
        await host.register();

        const result = await host.callback(goodQuery(state));

        expect(result.authSuccess).toBe(true);
        expect(exchangeCount()).toBe(0);
        expect(await host.storedTokens()).toBeUndefined();
      }),
    slowTest
  );
});

describe("the requests of the library", () => {
  it(
    "go through the given fetch function with no deadline of their own",
    () =>
      inLibraryHost(async (host) => {
        await connected(host);
        oauth.expireAccessToken();
        await host.search();

        const oauthRequests = host.sent.filter(({ path }) => path !== "/mcp");
        expect(oauthRequests.map(({ path }) => path)).toEqual(
          expect.arrayContaining([
            "/.well-known/oauth-protected-resource/mcp",
            "/.well-known/oauth-authorization-server",
            "/token",
          ])
        );
        expect(oauthRequests.some(({ hasSignal }) => hasSignal)).toBe(false);
        expect(host.sent).toHaveLength(fakeMcpServer.requests);
      }),
    slowTest
  );

  it(
    "are refused by the outbound guard for a private token endpoint",
    () => {
      oauth.useTokenEndpoint("https://127.0.0.1/token");
      return inLibraryHost(async (host) => {
        await host.register();
        const { state } = await host.startAuthorization();

        const result = await host.callback(goodQuery(state));

        expect(result).toHaveProperty(
          "authError",
          "The MCP Hub refused a request: The address is private"
        );
      });
    },
    slowTest
  );
});
