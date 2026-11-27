export const fakeOAuthSecrets = {
  authorizationCode: "fake-authorization-code-7c1e",
  accessToken: "fake-access-token-4b9d",
  refreshToken: "fake-refresh-token-a82f",
  clientSecret: "fake-dcr-client-secret-3e65",
} as const;

export const fakeOAuthAccountName = "Pat Reader";

export const createFakeOAuthServer = () => {
  const registrations: unknown[] = [];
  const tokenRequests: Record<string, string>[] = [];
  const state = {
    supportsClientIdMetadata: true,
    supportsPkce: true,
    sendsIssuer: true,
    tokenLoginRefused: false,
    requiresClientSecret: false,
    registeredMethod: "client_secret_post" as string,
    tokenHold: Promise.resolve(undefined) as Promise<undefined>,
    withRefreshToken: true,
    withAccountName: true,
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
    authorization_response_iss_parameter_supported: state.sendsIssuer,
    code_challenge_methods_supported: state.supportsPkce ? ["S256"] : [],
    client_id_metadata_document_supported: state.supportsClientIdMetadata,
  });

  const answerTenantLayout = (request: Request) => {
    const url = new URL(request.url);
    const { origin } = url;
    const tenant = `${origin}/tenant1`;
    if (request.method === "POST" && url.pathname === "/mcp") {
      return new Response(null, {
        status: 401,
        headers: {
          "WWW-Authenticate": `Bearer Resource_Metadata="${origin}/custom/prm"`,
        },
      });
    }
    if (url.pathname === "/custom/prm") {
      return Response.json({
        resource: `${origin}/mcp`,
        authorization_servers: [tenant],
      });
    }
    if (
      url.pathname === "/.well-known/oauth-authorization-server/tenant1" &&
      state.layout === "challenged_tenant"
    ) {
      return Response.json(metadataOf(tenant));
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return Response.json(metadataOf(origin));
    }
    return new Response(null, { status: 404 });
  };

  const hasClientSecret = (request: Request, form: URLSearchParams) =>
    state.registeredMethod === "client_secret_basic"
      ? request.headers.get("Authorization") ===
        `Basic ${btoa(`fake-dcr-client:${fakeOAuthSecrets.clientSecret}`)}`
      : form.get("client_secret") === fakeOAuthSecrets.clientSecret;

  const answerToken = async (request: Request) => {
    const form = new URLSearchParams(await request.text());
    tokenRequests.push(Object.fromEntries(form));
    await state.tokenHold;
    if (
      state.tokenLoginRefused ||
      (state.requiresClientSecret && !hasClientSecret(request, form)) ||
      form.get("grant_type") !== "authorization_code" ||
      form.get("code") !== fakeOAuthSecrets.authorizationCode
    ) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    return Response.json({
      access_token: fakeOAuthSecrets.accessToken,
      token_type: "Bearer",
      expires_in: 3600,
      ...(state.withRefreshToken
        ? { refresh_token: fakeOAuthSecrets.refreshToken }
        : {}),
      ...(state.withAccountName ? { account_name: fakeOAuthAccountName } : {}),
    });
  };

  const answer = async (request: Request) => {
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
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/mcp") {
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="${url.origin}/custom/prm"`,
          },
        });
      }
      if (url.pathname === "/custom/prm") {
        return Response.json({ authorization_servers: "not a list" });
      }
    }
    if (
      (state.layout === "challenged_tenant" ||
        state.layout === "root_metadata_only") &&
      !request.url.includes("/register")
    ) {
      return answerTenantLayout(request);
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
          client_secret: fakeOAuthSecrets.clientSecret,
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
    sendRefreshToken: (sent: boolean) => {
      state.withRefreshToken = sent;
    },
    sendAccountName: (sent: boolean) => {
      state.withAccountName = sent;
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
      state.registeredMethod = "client_secret_post";
      state.tokenHold = Promise.resolve(undefined);
      state.withRefreshToken = true;
      state.withAccountName = true;
      state.requiresToken = false;
      state.tokenEndpoint = undefined;
      registrations.length = 0;
      tokenRequests.length = 0;
    },
  };
};
