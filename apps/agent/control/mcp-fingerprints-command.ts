import { Console, Effect } from "effect";
import { Command, Flag } from "effect/cli";

import { readMcpFingerprints } from "./mcp-fingerprints.ts";
import { localWorkerUrl, operatorToken } from "./operator.ts";

export const mcpFingerprints = Command.make(
  "mcp-fingerprints",
  {
    owner: Flag.String("owner").pipe(
      Flag.withDescription("The Owner Id that has the MCP Connection")
    ),
    connection: Flag.String("connection").pipe(
      Flag.withDescription("The catalog id of the MCP Connection")
    ),
    url: Flag.String("url").pipe(
      Flag.withDescription("The Worker URL"),
      Flag.withDefault(localWorkerUrl)
    ),
  },
  ({ owner, connection, url }) =>
    Effect.gen(function* mcpFingerprintsCommand() {
      const token = yield* operatorToken;
      const definitions = yield* readMcpFingerprints({
        workerUrl: url,
        token,
        ownerId: owner,
        catalogId: connection,
      });
      yield* Console.log(definitions);
    })
).pipe(
  Command.withDescription(
    "Fetch the tool list of a connected MCP server again through the Worker's Operator route, and print each tool definition with its fingerprint. Review the definitions, then add the fingerprints to the MCP Catalog entry to pin them. Reads OPERATOR_TOKEN from the environment or .dev.vars."
  )
);
