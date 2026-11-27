import { DateTime } from "effect";

import {
  connectionRecordKey,
  hubConnectionStateOf,
  lastErrorKey,
  lastErrorOf,
  removalMarkerKey,
  removalMarkerOf,
} from "./oauth-storage-keys.ts";
import type { HubConnectionState, McpLastError } from "./oauth-storage-keys.ts";

export type McpErrorNote = Omit<McpLastError, "atMillis">;

export class McpConnectionLedger {
  private readonly storage: DurableObjectStorage;

  private ownerRemoved = false;

  constructor(storage: DurableObjectStorage) {
    this.storage = storage;
  }

  async stateOf(catalogId: string): Promise<HubConnectionState | undefined> {
    return hubConnectionStateOf(
      await this.storage.get(connectionRecordKey(catalogId))
    );
  }

  async isReady(catalogId: string) {
    return (await this.stateOf(catalogId)) === "ready";
  }

  async lastErrorOf(catalogId: string) {
    return lastErrorOf(await this.storage.get(lastErrorKey(catalogId)));
  }

  async removalOf(catalogId: string) {
    return removalMarkerOf(await this.storage.get(removalMarkerKey(catalogId)));
  }

  async isBeingRemoved(catalogId: string) {
    return this.ownerRemoved || (await this.removalOf(catalogId)) !== undefined;
  }

  markOwnerRemoved() {
    this.ownerRemoved = true;
  }

  markBeingRemoved(
    catalogId: string,
    marker: "pending" | "revoked" | "failed" | "not_attempted"
  ) {
    return this.storage.put(removalMarkerKey(catalogId), marker);
  }

  clearBeingRemoved(catalogId: string) {
    return this.storage.delete(removalMarkerKey(catalogId));
  }

  markReady(catalogId: string) {
    return this.storage.put(connectionRecordKey(catalogId), "ready");
  }

  remove(catalogId: string) {
    return this.storage.delete(connectionRecordKey(catalogId));
  }

  recordError(catalogId: string, note: McpErrorNote) {
    return this.storage.put<McpLastError>(lastErrorKey(catalogId), {
      ...note,
      atMillis: DateTime.toEpochMillis(DateTime.nowUnsafe()),
    });
  }

  async enterNeedsSignIn(catalogId: string, note: McpErrorNote) {
    await this.storage.put({
      [connectionRecordKey(catalogId)]: "needs_sign_in",
      [lastErrorKey(catalogId)]: {
        ...note,
        atMillis: DateTime.toEpochMillis(DateTime.nowUnsafe()),
      },
    });
  }
}
