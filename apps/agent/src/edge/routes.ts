export const edgeRoutes = [
  {
    method: "POST",
    path: "/telegram/webhook",
    access: "Telegram secret token in X-Telegram-Bot-Api-Secret-Token",
    purpose:
      "Receives a Telegram update, finds the Owner through the Directory, and stores the Event in the Owner's Personal Agent before it answers 200.",
  },
  {
    method: "POST",
    path: "/operator/owners",
    access: "Operator token as Authorization: Bearer",
    purpose:
      "Adds an Owner with a Telegram Channel Identity through the Directory. Registration stays closed.",
  },
  {
    method: "POST",
    path: "/operator/mcp-connections",
    access: "Operator token as Authorization: Bearer",
    purpose:
      "Adds an MCP Connection for an Owner from the MCP Catalog through the Owner's MCP Hub. Only the test-only catalog entry exists now.",
  },
  {
    method: "GET",
    path: "/mcp/connect",
    access:
      "Telegram login data from a login_url button, signed with the bot token, fresh, and from the Owner's Channel Identity",
    purpose:
      "Shows the consent page for connecting an MCP server. It starts nothing.",
  },
  {
    method: "POST",
    path: "/mcp/connect",
    access:
      "The same Telegram login data, in the form that the consent page sends",
    purpose:
      "Asks the Owner's MCP Hub to start OAuth with PKCE and redirects to the authorization server.",
  },
  {
    method: "GET",
    path: "/oauth/client-metadata.json",
    access: "Public",
    purpose:
      "Serves the OAuth Client ID Metadata Document of the agent. It exists on HTTPS only.",
  },
] as const;

export type EdgeRoute = (typeof edgeRoutes)[number];

type KeyOf<Route extends EdgeRoute> = Route extends EdgeRoute
  ? `${Route["method"]} ${Route["path"]}`
  : never;

export type EdgeRouteKey = KeyOf<EdgeRoute>;
