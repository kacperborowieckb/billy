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
      "Adds an MCP Connection with no sign-in for an Owner from the MCP Catalog through the Owner's MCP Hub. It serves the test-only catalog entry; a server that needs OAuth is connected from the chat.",
  },
  {
    method: "POST",
    path: "/operator/mcp-connections/refresh",
    access: "Operator token as Authorization: Bearer",
    purpose:
      "Asks the Owner's MCP Hub to fetch the tool list of a connected MCP server again and to send the new tool catalog copy to the Personal Agent. The answer also holds the sanitized last error of the MCP Connection (phase, reason, HTTP status, time) and, after a good fetch, each tool definition of the copy with its fingerprint, so the Operator can review the definitions and pin them in the MCP Catalog.",
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
      "Asks the Owner's MCP Hub to start OAuth with PKCE and answers with a page that goes on to the authorization server.",
  },
  {
    method: "GET",
    path: "/oauth/callback",
    access:
      "The state that the authorization server returns: the routing id of the Owner's MCP Hub and a single-use nonce",
    purpose:
      "Finds the MCP Hub from the routing id and asks it to check the nonce and the issuer, exchange the code, and finish the MCP Connection. A replay of a good callback shows the same result.",
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
