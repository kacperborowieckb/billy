import { Console, Effect } from "effect";

import type { FlowObservation } from "../../mcp-flow/flow-contract.ts";
import { fakeOAuthSecrets } from "../fake-oauth-server.ts";
import { flowCheck } from "./flow-checks.ts";

type JournalEntry = FlowObservation["journal"][number];

const shownTags = /^(?:Mcp|Approval)/u;

const lineOf = ({ _tag, eventId: _eventId, ...fields }: JournalEntry) =>
  `${String(_tag)} ${JSON.stringify(fields)}`;

const expectedLines = [
  'McpConnectionAdded {"catalogId":"notion"}',
  'McpToolCalled {"catalogId":"notion","tool":"notion-search","riskClass":"read","status":"done"}',
  'McpToolCalled {"catalogId":"notion","tool":"notion-fetch","riskClass":"read","status":"done"}',
  "ApprovalPending",
  '"answer":"approve"',
  'McpToolCalled {"catalogId":"notion","tool":"notion-create-pages","riskClass":"approve","status":"done"}',
  '"result":"executed"',
  'McpConnectionRemoved {"catalogId":"notion","revocation":"revoked"}',
];

const firstMissingInOrder = (
  lines: readonly string[],
  expected: readonly string[]
) => {
  const remaining = [...expected];
  for (const line of lines) {
    if (remaining[0] !== undefined && line.includes(remaining[0])) {
      remaining.shift();
    }
  }
  return remaining[0];
};

export const checkFlowJournal = Effect.fnUntraced(function* checkJournal(
  observation: FlowObservation,
  seenTexts: readonly string[]
) {
  const lines = observation.journal
    .filter(({ _tag }) => shownTags.test(String(_tag)))
    .map(lineOf);
  yield* Console.log(
    [
      `Journal (${observation.journal.length} entries, MCP and Approval entries shown):`,
      ...lines.map((line) => `  ${line}`),
    ].join("\n")
  );
  const missing = firstMissingInOrder(lines, expectedLines);
  yield* flowCheck(
    "Journal entries",
    missing === undefined,
    `no entry in order with ${missing ?? ""}`
  );
  const everything = [JSON.stringify(observation.journal), ...seenTexts].join(
    "\n"
  );
  const leaked = Object.entries(fakeOAuthSecrets)
    .filter(([, value]) => everything.includes(value))
    .map(([name]) => name);
  yield* flowCheck(
    "secrets",
    leaked.length === 0,
    `found ${leaked.join(", ")} in the Journal or in the chat`
  );
  yield* Console.log(
    "No OAuth token, code, or client secret is in the Journal or in the chat."
  );
});
