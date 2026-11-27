import { Schema } from "effect";

import type { FetchFunction } from "./mcp-outbound-guard.ts";
import { OAuthDiscoveryFailedError } from "./oauth-discovery.ts";
import type { OAuthDiscovery } from "./oauth-discovery.ts";

const RegistrationSchema = Schema.Struct({ client_id: Schema.String });

const decodeRegistration = Schema.decodeUnknownSync(RegistrationSchema);

const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCodePoint(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const randomToken = () => base64Url(crypto.getRandomValues(new Uint8Array(32)));

const challengeOf = async (verifier: string) =>
  base64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
    )
  );

export interface PendingOAuth {
  readonly catalogId: string;
  readonly codeVerifier: string;
  readonly clientId: string;
  readonly redirectUrl: string;
  readonly issuer: string;
  readonly expiresAtMillis: number;
}

export interface OAuthStartInput {
  readonly send: FetchFunction;
  readonly discovery: OAuthDiscovery;
  readonly catalogId: string;
  readonly serverUrl: string;
  readonly redirectUrl: string;
  readonly clientMetadataUrl: string | undefined;
  readonly clientName: string;
  readonly routingId: string;
  readonly nowMillis: number;
  readonly lifetimeMillis: number;
}

const registeredClientId = async ({
  send,
  discovery,
  redirectUrl,
  clientName,
  clientMetadataUrl,
}: OAuthStartInput) => {
  if (discovery.clientMode === "CIMD" && clientMetadataUrl !== undefined) {
    return clientMetadataUrl;
  }
  const endpoint = discovery.server.registration_endpoint;
  if (endpoint === undefined) {
    throw new OAuthDiscoveryFailedError(
      "The authorization server accepts no client"
    );
  }
  const response = await send(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!response.ok) {
    throw new OAuthDiscoveryFailedError("The client registration was refused");
  }
  return decodeRegistration(await response.json<unknown>()).client_id;
};

export interface StartedOAuth {
  readonly nonce: string;
  readonly pending: PendingOAuth;
  readonly authorizationUrl: string;
}

export const startOAuth = async (
  input: OAuthStartInput
): Promise<StartedOAuth> => {
  const clientId = await registeredClientId(input);
  const codeVerifier = randomToken();
  const nonce = randomToken();
  const url = new URL(input.discovery.server.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", input.redirectUrl);
  url.searchParams.set("code_challenge", await challengeOf(codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", `${input.routingId}.${nonce}`);
  url.searchParams.set("resource", input.serverUrl);
  return {
    nonce,
    authorizationUrl: url.toString(),
    pending: {
      catalogId: input.catalogId,
      codeVerifier,
      clientId,
      redirectUrl: input.redirectUrl,
      issuer: input.discovery.server.issuer,
      expiresAtMillis: input.nowMillis + input.lifetimeMillis,
    },
  };
};
