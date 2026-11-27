export const createFakeOAuthServer = () => {
  const registrations: unknown[] = [];
  const state = {
    supportsClientIdMetadata: true,
    supportsPkce: true,
    layout: "root" as
      | "root"
      | "challenged_tenant"
      | "root_metadata_only"
      | "invalid_challenge",
  };

  const metadataOf = (issuer: string) => ({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    registration_endpoint: `${issuer}/register`,
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

  const answer = async (request: Request) => {
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
      return Response.json({ client_id: "fake-dcr-client" }, { status: 201 });
    }
    return null;
  };

  return {
    answer,
    registrations,
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
      registrations.length = 0;
    },
  };
};
