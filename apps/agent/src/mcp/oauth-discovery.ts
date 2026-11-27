import { Option, Schema } from "effect";

import { refusedReasonOf } from "./mcp-outbound-guard.ts";
import type { FetchFunction } from "./mcp-outbound-guard.ts";

const ProtectedResourceSchema = Schema.Struct({
  authorization_servers: Schema.optionalKey(Schema.Array(Schema.String)),
});

const AuthorizationServerSchema = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  registration_endpoint: Schema.optionalKey(Schema.String),
  code_challenge_methods_supported: Schema.optionalKey(
    Schema.Array(Schema.String)
  ),
  client_id_metadata_document_supported: Schema.optionalKey(Schema.Boolean),
});

export type AuthorizationServer = typeof AuthorizationServerSchema.Type;

export type OAuthClientMode = "CIMD" | "DCR";

export interface OAuthDiscovery {
  readonly server: AuthorizationServer;
  readonly clientMode: OAuthClientMode;
}

export class OAuthDiscoveryFailedError extends Error {
  override readonly name = "OAuthDiscoveryFailedError";
}

const decodeProtectedResource = Schema.decodeUnknownOption(
  ProtectedResourceSchema
);
const decodeAuthorizationServer = Schema.decodeUnknownOption(
  AuthorizationServerSchema
);

const wellKnownUrls = (base: URL, suffix: string) => {
  const path = base.pathname === "/" ? "" : base.pathname.replace(/\/+$/u, "");
  const { origin } = base;
  return [
    `${origin}/.well-known/${suffix}${path}`,
    `${origin}/.well-known/${suffix}`,
  ];
};

const fetchJson = async (send: FetchFunction, url: string) => {
  try {
    const response = await send(url, {
      headers: { Accept: "application/json" },
    });
    return response.ok
      ? Option.some(await response.json<unknown>())
      : Option.none<unknown>();
  } catch {
    return Option.none<unknown>();
  }
};

const firstJson = async (send: FetchFunction, urls: readonly string[]) => {
  const answers = await Promise.all(urls.map((url) => fetchJson(send, url)));
  return answers.find(Option.isSome) ?? Option.none<unknown>();
};

const challengeProbeTimeoutMillis = 5000;

const resourceMetadataPattern = /resource_metadata="(?<url>[^"]+)"/iu;

const initializeBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "billy-mcp-hub", version: "1.0.0" },
  },
});

const challengedMetadataUrl = async (send: FetchFunction, serverUrl: URL) => {
  try {
    const response = await send(serverUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: initializeBody,
      signal: AbortSignal.timeout(challengeProbeTimeoutMillis),
    });
    const challenge = response.headers.get("WWW-Authenticate") ?? "";
    const url = resourceMetadataPattern.exec(challenge)?.groups?.["url"];
    return url !== undefined && URL.canParse(url) ? [url] : [];
  } catch {
    return [];
  }
};

const issuerOf = async (send: FetchFunction, serverUrl: URL) => {
  const resource = await firstJson(send, [
    ...(await challengedMetadataUrl(send, serverUrl)),
    ...wellKnownUrls(serverUrl, "oauth-protected-resource"),
  ]);
  const listed = resource.pipe(
    Option.flatMap(decodeProtectedResource),
    Option.flatMap((metadata) =>
      Option.fromNullishOr(metadata.authorization_servers?.at(0))
    )
  );
  return Option.getOrElse(listed, () => serverUrl.origin);
};

const matchingMetadata = async (
  send: FetchFunction,
  urls: readonly string[],
  issuer: string
) => {
  const answers = await Promise.all(urls.map((url) => fetchJson(send, url)));
  return answers
    .map((answer) => answer.pipe(Option.flatMap(decodeAuthorizationServer)))
    .find(
      (candidate) =>
        Option.isSome(candidate) && candidate.value.issuer === issuer
    );
};

const isHttps = (value: string) =>
  URL.canParse(value) && new URL(value).protocol === "https:";

const modeFor = (
  server: AuthorizationServer,
  clientMetadataUrl: string | undefined
): Option.Option<OAuthClientMode> => {
  if (
    server.client_id_metadata_document_supported === true &&
    clientMetadataUrl !== undefined &&
    isHttps(clientMetadataUrl)
  ) {
    return Option.some("CIMD");
  }
  return server.registration_endpoint === undefined
    ? Option.none()
    : Option.some("DCR");
};

export interface OAuthDiscoveryInput {
  readonly send: FetchFunction;
  readonly allowedOrigins: readonly string[];
  readonly serverUrl: string;
  readonly clientMetadataUrl: string | undefined;
}

export const discoverOAuth = async ({
  send,
  allowedOrigins,
  serverUrl,
  clientMetadataUrl,
}: OAuthDiscoveryInput): Promise<OAuthDiscovery> => {
  const issuerText = await issuerOf(send, new URL(serverUrl));
  const issuer = new URL(issuerText);
  const server = await matchingMetadata(
    send,
    [
      ...wellKnownUrls(issuer, "oauth-authorization-server"),
      ...wellKnownUrls(issuer, "openid-configuration"),
      `${issuerText.replace(/\/+$/u, "")}/.well-known/openid-configuration`,
    ],
    issuerText
  );
  if (server === undefined || Option.isNone(server)) {
    throw new OAuthDiscoveryFailedError(
      "The authorization server has no metadata"
    );
  }
  if (!server.value.code_challenge_methods_supported?.includes("S256")) {
    throw new OAuthDiscoveryFailedError(
      "The authorization server has no PKCE S256"
    );
  }
  if (
    !URL.canParse(server.value.authorization_endpoint) ||
    refusedReasonOf(
      new URL(server.value.authorization_endpoint),
      allowedOrigins
    ) !== undefined
  ) {
    throw new OAuthDiscoveryFailedError(
      "The authorization endpoint is not a public HTTPS address"
    );
  }
  const clientMode = modeFor(server.value, clientMetadataUrl);
  if (Option.isNone(clientMode)) {
    throw new OAuthDiscoveryFailedError(
      "The authorization server accepts no client"
    );
  }
  return { server: server.value, clientMode: clientMode.value };
};
