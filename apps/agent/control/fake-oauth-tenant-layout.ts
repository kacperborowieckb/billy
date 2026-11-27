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
