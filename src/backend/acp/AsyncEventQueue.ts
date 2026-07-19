/** Single-consumer async queue bridging ACP push callbacks to a pull stream. */

/**
 * Buffers values pushed from ACP `session/update` callbacks and exposes them as
 * an async iterable so `BackendAdapter.send` can `yield*` them. One producer
 * (`push`/`close`) and one consumer (the async iterator) are assumed; the queue
 * never drops values and ends the iteration once closed and drained.
 */
export class AsyncEventQueue<T> {
  private readonly buffer: T[] = [];
  private closed = false;
  private pendingResolve: (() => void) | null = null;

  /** Enqueues a value and wakes a waiting consumer. No-op once closed. */
  public push(value: T): void {
    if (this.closed) {
      return;
    }

    this.buffer.push(value);
    this.wake();
  }

  /** Marks the queue complete; the consumer ends after draining buffered values. */
  public close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.wake();
  }

  /** Yields buffered values in order, then returns once closed and empty. */
  public async *drain(): AsyncGenerator<T, void, void> {
    while (true) {
      while (this.buffer.length > 0) {
        yield this.buffer.shift() as T;
      }

      if (this.closed) {
        return;
      }

      await new Promise<void>((resolve) => {
        this.pendingResolve = resolve;
      });
    }
  }

  /** Resolves a pending consumer wait, if any. */
  private wake(): void {
    const resolve = this.pendingResolve;
    if (resolve !== null) {
      this.pendingResolve = null;
      resolve();
    }
  }
}
