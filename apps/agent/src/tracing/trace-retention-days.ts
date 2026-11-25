import { Schema } from "effect";

export const traceRetentionFloorDays = 7;

export const TraceRetentionDaysSchema = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(traceRetentionFloorDays)),
  Schema.brand("TraceRetentionDays")
);

export type TraceRetentionDays = typeof TraceRetentionDaysSchema.Type;
