import { eq } from "drizzle-orm";
import { Context, DateTime, Effect, Layer, Schema } from "effect";

import { AgentStorage } from "../personal-agent/agent-storage.ts";
import { mcpConnectionStates } from "../personal-agent/storage-values.ts";
import type { McpConnectionState } from "../personal-agent/storage-values.ts";
import type { McpCatalog } from "./mcp-catalog.ts";
import { mcpConnectRequests, mcpConnections, mcpTools } from "./mcp-schema.ts";
import { McpToolCopySchema } from "./mcp-tool-copy.ts";
import type { McpToolCopy } from "./mcp-tool-copy.ts";

export const McpConnectionStateSchema = Schema.Literals(mcpConnectionStates);

export interface McpConnectionRecord {
  readonly catalogId: string;
  readonly state: McpConnectionState;
}

const AnnotationsJsonSchema = Schema.fromJsonString(
  McpToolCopySchema.fields.annotations
);

const InputSchemaJsonSchema = Schema.fromJsonString(
  McpToolCopySchema.fields.inputSchema
);

const decodeAnnotations = Schema.decodeUnknownEffect(AnnotationsJsonSchema);
const decodeInputSchema = Schema.decodeUnknownEffect(InputSchemaJsonSchema);
const encodeAnnotations = Schema.encodeSync(AnnotationsJsonSchema);
const encodeInputSchema = Schema.encodeSync(InputSchemaJsonSchema);

const makeMcpConnections = (catalog: McpCatalog) =>
  Effect.gen(function* makeMcpConnectionsEffect() {
    const { database } = yield* AgentStorage;

    const states = database
      .select({
        catalogId: mcpConnections.catalogId,
        state: mcpConnections.state,
      })
      .from(mcpConnections)
      .pipe(Effect.map((rows): readonly McpConnectionRecord[] => rows));

    const stateOf = Effect.fnUntraced(function* stateOf(catalogId: string) {
      const rows = yield* database
        .select({ state: mcpConnections.state })
        .from(mcpConnections)
        .where(eq(mcpConnections.catalogId, catalogId));
      return rows.at(0)?.state;
    });

    const setState = Effect.fnUntraced(function* setState(
      catalogId: string,
      state: McpConnectionState
    ) {
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      yield* database
        .insert(mcpConnections)
        .values({ catalogId, state, updatedAt })
        .onConflictDoUpdate({
          target: mcpConnections.catalogId,
          set: { state, updatedAt },
        });
    });

    const tools = Effect.fnUntraced(function* tools(catalogId: string) {
      const rows = yield* database
        .select()
        .from(mcpTools)
        .where(eq(mcpTools.catalogId, catalogId));
      const copies: McpToolCopy[] = [];
      for (const row of rows) {
        copies.push({
          name: row.name,
          description: row.description,
          inputSchema: yield* decodeInputSchema(row.inputSchema),
          annotations: yield* decodeAnnotations(row.annotations),
        });
      }
      return copies;
    });

    const replaceTools = (catalogId: string, copy: readonly McpToolCopy[]) =>
      database.transaction(() =>
        Effect.gen(function* replaceToolsEffect() {
          yield* database
            .delete(mcpTools)
            .where(eq(mcpTools.catalogId, catalogId));
          if (copy.length > 0) {
            yield* database.insert(mcpTools).values(
              copy.map((tool) => ({
                catalogId,
                name: tool.name,
                description: tool.description,
                inputSchema: encodeInputSchema(tool.inputSchema),
                annotations: encodeAnnotations(tool.annotations),
              }))
            );
          }
        })
      );

    const requestConnect = (eventId: string, catalogId: string) =>
      database
        .insert(mcpConnectRequests)
        .values({ eventId, catalogId })
        .onConflictDoNothing();

    const connectRequestsOf = (eventId: string) =>
      database
        .select({ catalogId: mcpConnectRequests.catalogId })
        .from(mcpConnectRequests)
        .where(eq(mcpConnectRequests.eventId, eventId))
        .pipe(Effect.map((rows) => rows.map(({ catalogId }) => catalogId)));

    const settleConnectRequests = (eventId: string) =>
      database
        .delete(mcpConnectRequests)
        .where(eq(mcpConnectRequests.eventId, eventId));

    const remove = (catalogId: string) =>
      database.transaction(() =>
        Effect.gen(function* removeEffect() {
          const removed = yield* database
            .delete(mcpConnections)
            .where(eq(mcpConnections.catalogId, catalogId))
            .returning({ catalogId: mcpConnections.catalogId });
          yield* database
            .delete(mcpTools)
            .where(eq(mcpTools.catalogId, catalogId));
          yield* database
            .delete(mcpConnectRequests)
            .where(eq(mcpConnectRequests.catalogId, catalogId));
          return removed.length > 0;
        })
      );

    return {
      catalog,
      remove,
      states,
      stateOf,
      setState,
      tools,
      replaceTools,
      requestConnect,
      connectRequestsOf,
      settleConnectRequests,
    };
  });

export class McpConnections extends Context.Service<
  McpConnections,
  Effect.Success<ReturnType<typeof makeMcpConnections>>
>()("McpConnections") {
  static readonly layer = (catalog: McpCatalog) =>
    Layer.effect(McpConnections, makeMcpConnections(catalog));
}
