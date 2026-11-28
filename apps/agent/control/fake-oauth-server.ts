import { identityFieldsOf } from "./fake-oauth-identity.ts";
import { createFakeRefreshGrant } from "./fake-oauth-refresh.ts";
import { createFakeRevocationEndpoint } from "./fake-oauth-revocation.ts";
import {
  answerInvalidChallengeLayout,
  answerTenantLayout,
} from "./fake-oauth-tenant-layout.ts";

export const fakeOAuthSecrets = {
  authorizationCode: "fake-authorization-code-7c1e",
  accessToken: "fake-access-token-4b9d",
  refreshToken: "fake-refresh-token-a82f",
  clientSecret: "fake-dcr-client-secret-3e65",
} as const;

export const createFakeOAuthServer = () => {
  const refresh = createFakeRefreshGrant(fakeOAuthSecrets.refreshToken);
  const revocation = createFakeRevocationEndpoint();
  const registrations: unknown[] = [];
  const tokenRequests: Record<string, string>[] = [];
  const state = {
    supportsClientIdMetadata: true,
    supportsPkce: true,
    sendsIssuer: true,
    tokenLoginRefused: false,
    requiresClientSecret: false,
    freshTokens: false,
    exchanges: 0,
    registeredMethod: "client_secret_post" as string,
    tokenHold: Promise.resolve(undefined) as Promise<undefined>,
    metadataHold: Promise.resolve(undefined) as Promise<undefined>,
    heldMetadata: 0,
    withRefreshToken: true,
    withAccountName: true,
    workspaceName: undefined as string | undefined,
    requiresToken: false,
    tokenEndpoint: undefined as string | undefined,
    layout: "root" as
      | "root"
      | "challenged_tenant"
      | "root_metadata_only"
      | "invalid_challenge"
      | "hanging_metadata",
  };

  const metadataOf = (issuer: string) => ({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    registration_endpoint: `${issuer}/register`,
    token_endpoint: state.tokenEndpoint ?? `${issuer}/token`,
    ...revocation.metadataOf(issuer),
    authorization_response_iss_parameter_supported: state.sendsIssuer,
    code_challenge_methods_supported: state.supportsPkce ? ["S256"] : [],
    client_id_metadata_document_supported: state.supportsClientIdMetadata,
  });

  const currentAccessToken = () =>
    state.freshTokens
      ? `${fakeOAuthSecrets.accessToken}-${state.exchanges}`
      : fakeOAuthSecrets.accessToken;

  const hasClientSecret = (request: Request, form: URLSearchParams) =>
    state.registeredMethod === "client_secret_basic"
      ? request.headers.get("Authorization") ===
        `Basic ${btoa(`fake-dcr-client:${fakeOAuthSecrets.clientSecret}`)}`
      : form.get("client_secret") === fakeOAuthSecrets.clientSecret;

  const answerToken = async (request: Request) => {
    const form = new URLSearchParams(await request.text());
    tokenRequests.push(Object.fromEntries(form));
    await state.tokenHold;
    if (state.requiresClientSecret && !hasClientSecret(request, form)) {
      return Response.json({ error: "invalid_client" }, { status: 401 });
    }
    if (form.get("grant_type") === "refresh_token") {
      return refresh.answer(form, () => {
        state.exchanges += 1;
        return currentAccessToken();
      });
    }
    if (
      state.tokenLoginRefused ||
      (state.requiresClientSecret && !hasClientSecret(request, form)) ||
      form.get("grant_type") !== "authorization_code" ||
      form.get("code") !== fakeOAuthSecrets.authorizationCode
    ) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    state.exchanges += 1;
    refresh.accept(fakeOAuthSecrets.refreshToken);
    return Response.json({
      access_token: currentAccessToken(),
      token_type: "Bearer",
      expires_in: 3600,
      ...(state.withRefreshToken
        ? { refresh_token: fakeOAuthSecrets.refreshToken }
        : {}),
      ...identityFieldsOf(state),
    });
  };

  const answer = async (request: Request) => {
    if (new URL(request.url).pathname.includes("/.well-known/")) {
      state.heldMetadata += 1;
      await state.metadataHold;
    }
    if (await revocation.takes(request)) {
      return revocation.answer(request);
    }
    if (
      request.method === "POST" &&
      new URL(request.url).pathname.endsWith("/token")
    ) {
      return answerToken(request);
    }
    if (
      state.layout === "hanging_metadata" &&
      /oauth-protected-resource|openid-configuration/u.test(request.url)
    ) {
      return new Response(new ReadableStream(), { status: 200 });
    }
    if (state.layout === "invalid_challenge") {
      const broken = answerInvalidChallengeLayout(request);
      if (broken !== null) {
        return broken;
      }
    }
    if (
      (state.layout === "challenged_tenant" ||
        state.layout === "root_metadata_only") &&
      !request.url.includes("/register")
    ) {
      return answerTenantLayout(request, state.layout, metadataOf);
    }
    const url = new URL(request.url);
    const { origin } = url;
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return Response.json({
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
      });
    }
    if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
      return Response.json(metadataOf(origin));
    }
    if (url.pathname.endsWith("/register") && request.method === "POST") {
      registrations.push(await request.json());
      return Response.json(
        {
          client_id: "fake-dcr-client",
          ...(state.registeredMethod === "none"
            ? {}
            : { client_secret: fakeOAuthSecrets.clientSecret }),
          token_endpoint_auth_method: state.registeredMethod,
        },
        { status: 201 }
      );
    }
    return null;
  };

  return {
    answer,
    registrations,
    tokenRequests,
    ...revocation.exposed,
    get requiresToken() {
      return state.requiresToken;
    },
    requireToken: (required: boolean) => {
      state.requiresToken = required;
    },
    useTokenEndpoint: (endpoint: string) => {
      state.tokenEndpoint = endpoint;
    },
    sendIssuer: (sent: boolean) => {
      state.sendsIssuer = sent;
    },
    currentAccessToken,
    issueFreshTokens: (fresh: boolean) => {
      state.freshTokens = fresh;
    },
    get heldMetadataRequests() {
      return state.heldMetadata;
    },
    holdMetadataRequests: () => {
      const { promise, resolve } = Promise.withResolvers<undefined>();
      state.metadataHold = promise;
      state.heldMetadata = 0;
      return () => resolve(undefined);
    },
    holdTokenRequests: () => {
      const { promise, resolve } = Promise.withResolvers<undefined>();
      state.tokenHold = promise;
      return () => resolve(undefined);
    },
    registerWithMethod: (method: string) => {
      state.registeredMethod = method;
    },
    requireClientSecret: (required: boolean) => {
      state.requiresClientSecret = required;
    },
    refuseCodes: (refused: boolean) => {
      state.tokenLoginRefused = refused;
    },
    expireAccessToken: () => {
      state.exchanges += 1;
    },
    ...refresh.controls,
    get refreshRequests() {
      return tokenRequests.filter(
        (request) => request["grant_type"] === "refresh_token"
      );
    },
    sendRefreshToken: (sent: boolean) => {
      state.withRefreshToken = sent;
    },
    sendAccountName: (sent: boolean) => {
      state.withAccountName = sent;
    },
    sendWorkspaceName: (name: string | undefined) => {
      state.workspaceName = name;
    },
    supportClientIdMetadata: (supported: boolean) => {
      state.supportsClientIdMetadata = supported;
    },
    useLayout: (layout: typeof state.layout) => {
      state.layout = layout;
    },
    supportPkce: (supported: boolean) => {
      state.supportsPkce = supported;
    },
    reset: () => {
      state.supportsClientIdMetadata = true;
      state.supportsPkce = true;
      state.layout = "root";
      state.sendsIssuer = true;
      state.tokenLoginRefused = false;
      state.requiresClientSecret = false;
      state.freshTokens = false;
      state.exchanges = 0;
      state.registeredMethod = "client_secret_post";
      state.tokenHold = Promise.resolve(undefined);
      state.metadataHold = Promise.resolve(undefined);
      state.withRefreshToken = true;
      refresh.reset();
      revocation.reset();
      state.withAccountName = true;
      state.workspaceName = undefined;
      state.requiresToken = false;
      state.tokenEndpoint = undefined;
      registrations.length = 0;
      tokenRequests.length = 0;
    },
  };
};
