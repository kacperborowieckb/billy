import { Data } from "effect";

export class ReviewFailed extends Data.TaggedError("ReviewFailed")<{
  readonly cause: "model_failed" | "invalid_answer" | "timed_out";
}> {}
