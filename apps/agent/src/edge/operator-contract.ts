import { Schema } from "effect";

export const AddOwnerRequestSchema = Schema.Struct({
  telegramUserId: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
});

export const AddOwnerResponseSchema = Schema.Struct({
  ownerId: Schema.String,
  channelIdentity: Schema.String,
  registration: Schema.Literals(["open", "closed"]),
});

export type AddOwnerResponse = typeof AddOwnerResponseSchema.Type;

export const AddMcpConnectionRequestSchema = Schema.Struct({
  ownerId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  catalogId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
});
