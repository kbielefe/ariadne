// One length-prefixed JSON frame per libp2p message.
import type { Stream } from '@libp2p/interface';

export const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
export const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

function asBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  const sub = (data as { subarray?: () => Uint8Array } | null)?.subarray;
  if (typeof sub === 'function') return new Uint8Array(sub.call(data));
  throw new Error('unexpected stream chunk');
}

export interface Frames {
  send(msg: unknown): Promise<void>;
  recv(): Promise<unknown>;
}

/** Reads and writes one JSON value at a time. Attach before any await so early bytes are not lost. */
export function frames(stream: Stream): Frames {
  let buf = new Uint8Array(0);
  const queue: unknown[] = [];
  const waiters: ((msg: unknown) => void)[] = [];
  const push = (chunk: Uint8Array) => {
    const next = new Uint8Array(buf.length + chunk.length);
    next.set(buf);
    next.set(chunk, buf.length);
    buf = next;
    while (buf.length >= 4) {
      const len = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0);
      if (len > 8_000_000) throw new Error('frame is too large');
      if (buf.length < 4 + len) return;
      const body = buf.slice(4, 4 + len);
      buf = buf.slice(4 + len);
      const msg = JSON.parse(new TextDecoder().decode(body)) as unknown;
      const waiter = waiters.shift();
      if (waiter) waiter(msg);
      else queue.push(msg);
    }
  };
  stream.addEventListener('message', (evt: Event) => {
    const data = (evt as CustomEvent<Uint8Array>).detail ?? (evt as { data?: unknown }).data;
    push(asBytes(data));
  });
  return {
    async send(msg) {
      const body = new TextEncoder().encode(JSON.stringify(msg));
      const out = new Uint8Array(4 + body.length);
      new DataView(out.buffer).setUint32(0, body.length);
      out.set(body, 4);
      await stream.send(out);
    },
    recv() {
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}
