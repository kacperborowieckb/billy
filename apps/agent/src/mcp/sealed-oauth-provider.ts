/* oxlint-disable class-methods-use-this */
import type { AgentMcpOAuthProvider } from "agents/mcp/do-oauth-client-provider";

import type { SealedCredentials } from "./sealed-credentials.ts";

export class SealedOAuthProvider implements AgentMcpOAuthProvider {
  authUrl: string | undefined;

  clientId: string | undefined;

  serverId: string | undefined;

  private readonly credentials: SealedCredentials;

  private readonly catalogId: string;

  private readonly clientName: string;

  constructor(
    credentials: SealedCredentials,
    catalogId: string,
    clientName: string
  ) {
    this.credentials = credentials;
    this.catalogId = catalogId;
    this.clientName = clientName;
  }

  get redirectUrl() {
    // oxlint-disable-next-line unicorn/no-useless-undefined
    return undefined;
  }

  get clientMetadata() {
    return {
      client_name: this.clientName,
      redirect_uris: [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  async clientInformation() {
    const client = await this.credentials.client(this.catalogId);
    return client === undefined
      ? undefined
      : {
          client_id: client.client_id,
          ...(client.client_secret === undefined
            ? {}
            : { client_secret: client.client_secret }),
        };
  }

  tokens() {
    return this.credentials.tokens(this.catalogId);
  }

  saveTokens(tokens: Parameters<AgentMcpOAuthProvider["saveTokens"]>[0]) {
    return this.credentials.saveTokens(this.catalogId, {
      access_token: tokens.access_token,
      token_type: tokens.token_type,
      ...(tokens.refresh_token === undefined
        ? {}
        : { refresh_token: tokens.refresh_token }),
      ...(tokens.expires_in === undefined
        ? {}
        : { expires_in: tokens.expires_in }),
      ...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
    });
  }

  redirectToAuthorization() {
    return Promise.resolve();
  }

  saveCodeVerifier() {
    return Promise.resolve();
  }

  codeVerifier(): Promise<string> {
    return Promise.reject(new Error("The hub keeps no code verifier here"));
  }

  checkState() {
    return Promise.resolve({
      valid: false,
      error: "The hub checks state itself",
    });
  }

  consumeState() {
    return Promise.resolve();
  }

  deleteCodeVerifier() {
    return Promise.resolve();
  }
}
