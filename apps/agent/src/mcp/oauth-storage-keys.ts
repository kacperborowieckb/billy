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

const decodeConnectionRecord = Schema.decodeUnknownOption(
  Schema.Literals(["ready", "needs_sign_in"])
);

export const connectionRecordKey = (catalogId: string) =>
  `connection:${catalogId}`;

export type HubConnectionState = "ready" | "needs_sign_in";

export const hubConnectionStateOf = (
  stored: unknown
): HubConnectionState | undefined =>
  stored === true
    ? "ready"
    : Option.getOrUndefined(decodeConnectionRecord(stored));

export const lastErrorKey = (catalogId: string) => `last-error:${catalogId}`;

export const McpLastErrorSchema = Schema.Struct({
  phase: Schema.Literals(["token_exchange", "connect", "refresh", "request"]),
  reason: Schema.Literals([
    "invalid_grant",
    "no_refresh_token",
    "no_token_endpoint",
    "unauthorized",
    "insufficient_scope",
    "unavailable",
    "failed",
  ]),
  httpStatus: Schema.optionalKey(Schema.Number),
  atMillis: Schema.Number,
});

export type McpLastError = typeof McpLastErrorSchema.Type;

export const lastErrorOf = (stored: unknown) =>
  Option.getOrUndefined(Schema.decodeUnknownOption(McpLastErrorSchema)(stored));

export const latestExchangeKey = (catalogId: string) =>
  `latest-exchange:${catalogId}`;

export const removalMarkerKey = (catalogId: string) => `removing:${catalogId}`;

const decodeRemovalMarker = Schema.decodeUnknownOption(
  Schema.Literals(["pending", "revoked", "failed", "not_attempted"])
);

export const removalMarkerOf = (stored: unknown) =>
  Option.getOrUndefined(decodeRemovalMarker(stored));
