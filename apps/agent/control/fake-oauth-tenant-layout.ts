export const answerTenantLayout = (
  request: Request,
  layout: string,
  metadataOf: (issuer: string) => unknown
) => {
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
    layout === "challenged_tenant"
  ) {
    return Response.json(metadataOf(tenant));
  }
  if (url.pathname === "/.well-known/oauth-authorization-server") {
    return Response.json(metadataOf(origin));
  }
  return new Response(null, { status: 404 });
};

export const answerInvalidChallengeLayout = (request: Request) => {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/mcp") {
    return new Response(null, {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer resource_metadata="${url.origin}/custom/prm"`,
      },
    });
  }
  return url.pathname === "/custom/prm"
    ? Response.json({ authorization_servers: "not a list" })
    : null;
};
