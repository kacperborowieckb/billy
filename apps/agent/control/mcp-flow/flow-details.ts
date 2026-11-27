import { isDeepStrictEqual } from "node:util";

import { Option, Schema } from "effect";

const decodeJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Unknown)
);

export interface ApprovedCall {
  readonly connection: string;
  readonly tool: string;
  readonly arguments: unknown;
}

export const detailsShowTheCall = (content: string, call: ApprovedCall) =>
  decodeJson(content).pipe(
    Option.exists((shown) => isDeepStrictEqual(shown, call))
  );
