import { Option, Schema } from "effect";

export const pendingOAuthKeyPrefix = "oauth:";

export const usedProofKeyPrefix = "proof:";

export const settledOAuthKeyPrefix = "settled:";

export const SettledOAuthSchema = Schema.Struct({
  ownerId: Schema.String,
  catalogId: Schema.String,
  issuer: Schema.String,
  issuerIsRequired: Schema.Boolean,
  accountLabel: Schema.optionalKey(Schema.String),
  expiresAtMillis: Schema.Number,
});

export type SettledOAuth = typeof SettledOAuthSchema.Type;

export const settledOAuthOf = (stored: unknown) =>
  Option.getOrUndefined(Schema.decodeUnknownOption(SettledOAuthSchema)(stored));
