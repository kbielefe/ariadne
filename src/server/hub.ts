import { EventEmitter } from 'node:events';

/** In-process signals: browsers (SSE) listen here. */
export class Hub {
  private readonly ee = new EventEmitter();

  constructor() {
    this.ee.setMaxListeners(0);
  }

  /** Something in the data changed; browsers refetch. */
  changed() {
    this.ee.emit('changed');
  }

  on(name: 'changed', fn: () => void): () => void {
    this.ee.on(name, fn);
    return () => this.ee.off(name, fn);
  }
}
