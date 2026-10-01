// Runs Ariadne's clock: due timers (claim checks, scheduled events) and overdue assignments.
// Started by main.ts whether or not RabbitMQ is configured.
import type { Log } from './bus';
import type { Core } from './core';

export function startScheduler(core: Core, log: Log, intervalMs = 15_000): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await core.fireDue();
      await core.sweepOverdue();
    } catch (err) {
      log.error('scheduler.failed', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  void tick();
  return () => clearInterval(timer);
}
