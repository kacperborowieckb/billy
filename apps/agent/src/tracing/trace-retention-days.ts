import { Schema } from "effect";

export const traceRetentionFloorDays = 7;

export const traceRetentionCeilingDays = 36_500;

export const TraceRetentionDaysSchema = Schema.Int.pipe(
  Schema.check(
    Schema.isGreaterThanOrEqualTo(traceRetentionFloorDays),
    Schema.isLessThanOrEqualTo(traceRetentionCeilingDays)
  ),
  Schema.brand("TraceRetentionDays")
);

export type TraceRetentionDays = typeof TraceRetentionDaysSchema.Type;
