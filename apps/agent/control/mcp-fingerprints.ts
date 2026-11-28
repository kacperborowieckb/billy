import { Data, Effect, Schema } from "effect";

import { RefreshMcpConnectionResponseSchema } from "../src/edge/operator-contract.ts";
import { operatorPost } from "./operator-request.ts";

export class McpFingerprintsNotRead extends Data.TaggedError(
  "McpFingerprintsNotRead"
)<{
  readonly status: number;
  readonly detail: string;
}> {
  override get message() {
    return `The Worker did not give the tool definitions of the MCP Connection (${this.status}): ${this.detail}`;
  }
}

const decodeResponse = Schema.decodeUnknownOption(
  Schema.fromJsonString(RefreshMcpConnectionResponseSchema)
);

const hiddenCharacters = /(?!\n)[\p{C}\p{Zl}\p{Zp}]/gu;

const escapedCodeUnit = (unit: string) =>
  `\\u${unit.codePointAt(0)?.toString(16).padStart(4, "0")}`;

const escaped = (character: string) =>
  character.split("").map(escapedCodeUnit).join("");

export const withHiddenCharactersShown = (text: string) =>
  text.replaceAll(hiddenCharacters, escaped);

export const readMcpFingerprints = Effect.fnUntraced(
  function* readMcpFingerprints({
    workerUrl,
    token,
    ownerId,
    catalogId,
  }: {
    readonly workerUrl: string;
    readonly token: string;
    readonly ownerId: string;
    readonly catalogId: string;
  }) {
    const response = yield* operatorPost({
      workerUrl,
      path: "/operator/mcp-connections/refresh",
      token,
      body: { ownerId, catalogId },
    });
    const body = yield* Effect.promise(() => response.text());
    const answer = decodeResponse(body);
    if (answer._tag === "None" || answer.value.tools === undefined) {
      return yield* new McpFingerprintsNotRead({
        status: response.status,
        detail: withHiddenCharactersShown(body),
      });
    }
    return withHiddenCharactersShown(
      JSON.stringify(
        answer.value.tools.map(
          ({ name, fingerprint, description, inputSchema, annotations }) => ({
            name,
            fingerprint,
            description,
            inputSchema,
            annotations,
          })
        ),
        null,
        2
      )
    );
  }
);
