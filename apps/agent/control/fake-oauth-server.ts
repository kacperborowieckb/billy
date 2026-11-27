export const createFakeOAuthServer = () => {
  const registrations: unknown[] = [];
  const state = { supportsClientIdMetadata: true, supportsPkce: true };

  const answer = async (request: Request) => {
    const url = new URL(request.url);
    const { origin } = url;
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return Response.json({
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
      });
    }
    if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
      return Response.json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        registration_endpoint: `${origin}/register`,
        code_challenge_methods_supported: state.supportsPkce ? ["S256"] : [],
        client_id_metadata_document_supported: state.supportsClientIdMetadata,
      });
    }
    if (url.pathname === "/register" && request.method === "POST") {
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
    supportPkce: (supported: boolean) => {
      state.supportsPkce = supported;
    },
    reset: () => {
      state.supportsClientIdMetadata = true;
      state.supportsPkce = true;
      registrations.length = 0;
    },
  };
};
