import { Schema } from "effect";

import {
  reviewAnswers,
  reviewFallbacks,
} from "../personal-agent/storage-values.ts";

export const ReviewRecordSchema = Schema.Struct({
  toolCallId: Schema.String,
  toolName: Schema.String,
  answer: Schema.Literals(reviewAnswers),
  reason: Schema.optionalKey(Schema.String),
  fallback: Schema.optionalKey(Schema.Literals(reviewFallbacks)),
});

export type ReviewRecord = typeof ReviewRecordSchema.Type;
