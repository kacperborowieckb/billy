import { DateTime, Schema } from "effect";

import { open, seal, sealingContextOf } from "./token-seal.ts";
import type { SealKeyring } from "./token-seal.ts";

export const StoredTokensSchema = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.String,
  refresh_token: Schema.optionalKey(Schema.String),
  expires_in: Schema.optionalKey(Schema.Number),
  scope: Schema.optionalKey(Schema.String),
  expires_at_millis: Schema.optionalKey(Schema.Number),
});

export type StoredTokens = typeof StoredTokensSchema.Type;

export const StoredClientSchema = Schema.Struct({
  client_id: Schema.String,
  client_secret: Schema.optionalKey(Schema.String),
  client_auth_method: Schema.optionalKey(Schema.Literals(["basic", "post"])),
  redirectUrl: Schema.String,
  tokenEndpoint: Schema.optionalKey(Schema.String),
  revocationEndpoint: Schema.optionalKey(Schema.String),
});

export type StoredClient = typeof StoredClientSchema.Type;

const TokensJsonSchema = Schema.fromJsonString(StoredTokensSchema);
const ClientJsonSchema = Schema.fromJsonString(StoredClientSchema);

const encodeTokens = Schema.encodeSync(TokensJsonSchema);
const decodeTokens = Schema.decodeUnknownSync(TokensJsonSchema);
const encodeClient = Schema.encodeSync(ClientJsonSchema);
const decodeClient = Schema.decodeUnknownSync(ClientJsonSchema);

const withExpiry = (tokens: StoredTokens): StoredTokens => {
  const { expires_at_millis: _stale, ...rest } = tokens;
  return tokens.expires_in === undefined
    ? rest
    : {
        ...rest,
        expires_at_millis:
          DateTime.toEpochMillis(DateTime.nowUnsafe()) +
          tokens.expires_in * 1000,
      };
};

const tokensKey = (catalogId: string) => `tokens:${catalogId}`;
const clientKey = (catalogId: string) => `client:${catalogId}`;

export const credentialKeysOf = (catalogId: string) => [
  tokensKey(catalogId),
  clientKey(catalogId),
];

export class SealedCredentials {
  private readonly storage: DurableObjectStorage;

  private readonly keyring: SealKeyring;

  private readonly ownerId: string;

  constructor(
    storage: DurableObjectStorage,
    keyring: SealKeyring,
    ownerId: string
  ) {
    this.storage = storage;
    this.keyring = keyring;
    this.ownerId = ownerId;
  }

  private contextOf(catalogId: string, purpose: string) {
    return sealingContextOf(this.ownerId, catalogId, purpose);
  }

  sealVerifier(catalogId: string, nonce: string, verifier: string) {
    return seal(
      this.keyring,
      verifier,
      this.contextOf(catalogId, `verifier:${nonce}`)
    );
  }

  openVerifier(catalogId: string, nonce: string, sealed: string) {
    return open(
      this.keyring,
      sealed,
      this.contextOf(catalogId, `verifier:${nonce}`)
    );
  }

  sealClientSecret(catalogId: string, nonce: string, secret: string) {
    return seal(
      this.keyring,
      secret,
      this.contextOf(catalogId, `client-secret:${nonce}`)
    );
  }

  openClientSecret(catalogId: string, nonce: string, sealed: string) {
    return open(
      this.keyring,
      sealed,
      this.contextOf(catalogId, `client-secret:${nonce}`)
    );
  }

  async sealedEntries(
    catalogId: string,
    tokens: StoredTokens,
    client: StoredClient
  ): Promise<Record<string, string>> {
    return {
      [tokensKey(catalogId)]: await seal(
        this.keyring,
        encodeTokens(withExpiry(tokens)),
        this.contextOf(catalogId, "tokens")
      ),
      [clientKey(catalogId)]: await seal(
        this.keyring,
        encodeClient(client),
        this.contextOf(catalogId, "client")
      ),
    };
  }

  async tokens(catalogId: string): Promise<StoredTokens | undefined> {
    const sealed = await this.storage.get<string>(tokensKey(catalogId));
    return sealed === undefined
      ? undefined
      : decodeTokens(
          await open(this.keyring, sealed, this.contextOf(catalogId, "tokens"))
        );
  }

  async client(catalogId: string): Promise<StoredClient | undefined> {
    const sealed = await this.storage.get<string>(clientKey(catalogId));
    return sealed === undefined
      ? undefined
      : decodeClient(
          await open(this.keyring, sealed, this.contextOf(catalogId, "client"))
        );
  }

  async saveTokens(catalogId: string, tokens: StoredTokens) {
    const previous = await this.tokens(catalogId);
    const refreshToken = tokens.refresh_token ?? previous?.refresh_token;
    await this.storage.put(
      tokensKey(catalogId),
      await seal(
        this.keyring,
        encodeTokens(
          withExpiry({
            ...tokens,
            ...(refreshToken === undefined
              ? {}
              : { refresh_token: refreshToken }),
          })
        ),
        this.contextOf(catalogId, "tokens")
      )
    );
  }

  forgetTokens(catalogId: string) {
    return this.storage.delete(tokensKey(catalogId));
  }
}
