import { Schema } from "effect";

export const flowObservationRoute = "/mcp-flow/observation";

export const FlowObservationRequestSchema = Schema.Struct({
  ownerId: Schema.String,
});

export const FlowObservationSchema = Schema.Struct({
  journal: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  serverCalls: Schema.Array(
    Schema.Struct({ tool: Schema.String, arguments: Schema.Unknown })
  ),
});

export type FlowObservation = typeof FlowObservationSchema.Type;
