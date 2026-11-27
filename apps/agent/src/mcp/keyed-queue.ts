export class KeyedQueue {
  private readonly tails = new Map<string, Promise<undefined>>();

  private readonly waiting = new Map<string, number>();

  waitingCount(key: string) {
    return this.waiting.get(key) ?? 0;
  }

  async run<Value>(key: string, work: () => Promise<Value>): Promise<Value> {
    const previous = this.tails.get(key);
    const turn = Promise.withResolvers<undefined>();
    const tail = (previous ?? Promise.resolve(undefined)).then(
      () => turn.promise
    );
    this.tails.set(key, tail);
    if (previous !== undefined) {
      this.waiting.set(key, this.waitingCount(key) + 1);
      await previous;
      this.waiting.set(key, this.waitingCount(key) - 1);
    }
    try {
      return await work();
    } finally {
      turn.resolve(undefined);
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }
}
