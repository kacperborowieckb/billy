import { Data } from "effect";

export class UnknownReviewCase extends Data.TaggedError("UnknownReviewCase")<{
  readonly names: readonly string[];
}> {
  override get message() {
    return `The fixed set has no case named ${this.names.join(", ")}.`;
  }
}
