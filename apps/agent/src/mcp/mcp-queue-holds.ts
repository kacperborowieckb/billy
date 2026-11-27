export class McpQueueHolds {
  private readonly holds = new Map<string, number>();

  isHeld(catalogId: string) {
    return (this.holds.get(catalogId) ?? 0) > 0;
  }

  async whileHeld<Value>(catalogId: string, work: () => Promise<Value>) {
    this.holds.set(catalogId, (this.holds.get(catalogId) ?? 0) + 1);
    try {
      return await work();
    } finally {
      const left = (this.holds.get(catalogId) ?? 1) - 1;
      if (left === 0) {
        this.holds.delete(catalogId);
      } else {
        this.holds.set(catalogId, left);
      }
    }
  }
}
