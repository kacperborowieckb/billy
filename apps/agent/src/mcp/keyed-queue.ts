export class KeyedQueue {
  private readonly tails = new Map<string, Promise<undefined>>();

  async run<Value>(key: string, work: () => Promise<Value>): Promise<Value> {
    const previous = this.tails.get(key) ?? Promise.resolve(undefined);
    const turn = Promise.withResolvers<undefined>();
    const tail = previous.then(() => turn.promise);
    this.tails.set(key, tail);
    await previous;
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
