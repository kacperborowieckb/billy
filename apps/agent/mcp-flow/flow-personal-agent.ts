import { Effect } from "effect";

import { fakeNotionTools } from "../control/mcp-flow/fake-notion-tools.ts";
import { Journal } from "../src/journal/journal.ts";
import type { McpCatalog } from "../src/mcp/mcp-catalog.ts";
import { toolCopyOf } from "../src/mcp/mcp-hub-results.ts";
import { mcpFingerprintsOf } from "../src/mcp/mcp-tool-fingerprint.ts";
import { notionCatalogEntry } from "../src/mcp/notion/notion-catalog-entry.ts";
import type { OwnerId } from "../src/owner-id.ts";
import {
  PersonalAgent,
  personalAgentFor,
} from "../src/personal-agent/personal-agent.ts";

const reviewedFingerprints = await mcpFingerprintsOf(
  fakeNotionTools.map(toolCopyOf)
);

const pinnedFakeNotionCatalog: McpCatalog = [
  {
    ...notionCatalogEntry,
    tools: notionCatalogEntry.tools.map((tool) => ({
      ...tool,
      fingerprint: reviewedFingerprints[tool.name] ?? "",
    })),
  },
];

export class FlowPersonalAgent extends PersonalAgent {
  protected override readonly mcpCatalog = pinnedFakeNotionCatalog;

  journal(): Promise<string> {
    return this.runtime.runPromise(
      Journal.pipe(
        Effect.flatMap((journal) => journal.read),
        Effect.map((entries) =>
          JSON.stringify(entries.map(({ record }) => record))
        )
      )
    );
  }
}

export const flowPersonalAgentFor = (env: Env, ownerId: OwnerId) =>
  personalAgentFor(
    env.PERSONAL_AGENT as unknown as DurableObjectNamespace<FlowPersonalAgent>,
    ownerId
  );
