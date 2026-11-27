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

const decodeExpiry = Schema.decodeUnknownOption(Schema.Number);

export const expiryOf = (stored: unknown) =>
  Option.getOrUndefined(decodeExpiry(stored));

const decodeRecorded = Schema.decodeUnknownOption(Schema.Literal(true));

export const connectionRecordKey = (catalogId: string) =>
  `connection:${catalogId}`;

export const isConnectionRecorded = (stored: unknown) =>
  Option.isSome(decodeRecorded(stored));
