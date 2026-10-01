import { EventEmitter } from 'node:events';

export interface StatusLine {
  actor: string;
  text: string;
  eventId?: string;
  at: string;
}

/** In-process signals: browsers (SSE), the relay, and waiting decide() calls listen here. */
export class Hub {
  private readonly ee = new EventEmitter();
  private readonly statuses = new Map<string, StatusLine>();

  constructor() {
    this.ee.setMaxListeners(0);
  }

  /** Something in the data changed; browsers refetch. */
  changed() {
    this.ee.emit('changed');
  }
  /** Events may be waiting to be published. */
  deliver() {
    this.ee.emit('deliver');
  }
  status(s: Omit<StatusLine, 'at'>) {
    const line = { ...s, at: new Date().toISOString() };
    if (s.text) this.statuses.set(s.actor, line);
    else this.statuses.delete(s.actor);
    this.ee.emit('status', line);
  }
  clearStatus(actor: string) {
    if (this.statuses.delete(actor)) this.ee.emit('status', { actor, text: '', at: new Date().toISOString() });
  }
  currentStatuses(): StatusLine[] {
    const cutoff = Date.now() - 10 * 60_000;
    return [...this.statuses.values()].filter((s) => Date.parse(s.at) > cutoff);
  }
  answered(eventId: string) {
    this.ee.emit(`answered:${eventId}`);
  }

  on(name: 'changed' | 'deliver', fn: () => void): () => void;
  on(name: 'status', fn: (s: StatusLine) => void): () => void;
  on(name: string, fn: (...a: any[]) => void): () => void {
    this.ee.on(name, fn);
    return () => this.ee.off(name, fn);
  }
  once(name: string, fn: () => void): () => void {
    this.ee.once(name, fn);
    return () => this.ee.off(name, fn);
  }
}
