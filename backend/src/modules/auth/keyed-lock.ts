/**
 * One at a time per key: parallel tests signing in as the same user wait for each other,
 * so the second one reuses the session the first one saved (no second MFA prompt, no
 * authenticator code used twice).
 */
export class KeyedLock {
  private tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(fn);
    const tail = current.catch(() => undefined);
    this.tails.set(key, tail);
    try {
      return await current;
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
