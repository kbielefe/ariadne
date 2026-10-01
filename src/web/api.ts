import { useEffect, useState } from 'react';
import type { Edge, Event, Node, Op } from '../shared/model';

export interface GraphData {
  nodes: Node[];
  edges: Edge[];
  assignments: { eventId: string; recipient: string; tasks: string[] }[];
}
export interface StatusLine {
  actor: string;
  text: string;
  eventId?: string;
  at: string;
}
export interface Timeline {
  events: Event[];
  changes: Record<string, { lines: string[]; undone: boolean; count: number }>;
  statuses: StatusLine[];
}
export interface NodeDetail {
  node: Node;
  edges: Edge[];
  neighbors: Node[];
  events: Event[];
  readiness?: { ready: boolean; waitingOn: string[] };
}

export class ApiError extends Error {}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  graph: () => call<GraphData>('GET', '/api/graph'),
  node: (id: string) => call<NodeDetail>('GET', `/api/nodes/${id}`),
  timeline: (focus: string | null, all: boolean) => call<Timeline>('GET', `/api/timeline?${new URLSearchParams({ ...(focus ? { focus } : {}), ...(all ? { all: '1' } : {}) })}`),
  ops: (ops: Op[]) => call<{ results: { op: string; id: string; ref?: string }[] }>('POST', '/api/ops', { ops }),
  chat: (text: string, focus: string | null) => call<Event>('POST', '/api/chat', { text, focus }),
  respond: (id: string, action: string, values: Record<string, unknown>) => call<Event>('POST', `/api/cards/${id}/respond`, { action, values }),
  undo: (because: string) => call<{ undone: number }>('POST', '/api/undo', { because }),
};

/** Live updates over SSE: `version` bumps whenever data changes; `statuses` are the status lines. */
export function useLive(): { version: number; statuses: StatusLine[]; connected: boolean } {
  const [version, setVersion] = useState(0);
  const [statuses, setStatuses] = useState<StatusLine[]>([]);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const es = new EventSource('/api/stream');
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Coalesce bursts (one MCP batch can change many things).
    const bump = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        setVersion((v) => v + 1);
      }, 120);
    };
    es.addEventListener('hello', (e) => {
      setConnected(true);
      setStatuses((JSON.parse((e as MessageEvent).data) as { statuses: StatusLine[] }).statuses);
      bump();
    });
    es.addEventListener('changed', bump);
    es.addEventListener('status', (e) => {
      const s = JSON.parse((e as MessageEvent).data) as StatusLine;
      setStatuses((list) => [...list.filter((x) => x.actor !== s.actor), ...(s.text ? [s] : [])]);
    });
    es.onerror = () => setConnected(false);
    return () => {
      es.close();
      if (timer) clearTimeout(timer);
    };
  }, []);
  return { version, statuses, connected };
}

/** localStorage that never throws (private windows, blocked storage). */
export const remember = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null) {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* fine */
    }
  },
};
