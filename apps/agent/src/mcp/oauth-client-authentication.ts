import type { StoredClient } from "./sealed-credentials.ts";

export interface ClientAuthentication {
  readonly headers: Readonly<Record<string, string>>;
  readonly fields: Readonly<Record<string, string>>;
}

export const clientAuthenticationOf = (
  client: StoredClient
): ClientAuthentication => {
  if (client.client_secret === undefined) {
    return { headers: {}, fields: {} };
  }
  if ((client.client_auth_method ?? "basic") === "post") {
    return { headers: {}, fields: { client_secret: client.client_secret } };
  }
  return {
    headers: {
      Authorization: `Basic ${btoa(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`)}`,
    },
    fields: {},
  };
};
