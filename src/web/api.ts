import { useEffect, useState } from 'react';
import type { Edge, Event, Node, Op } from '../shared/model';

export interface GraphData {
  nodes: Node[];
  edges: Edge[];
  assignments: { eventId: string; recipient: string; tasks: string[] }[];
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
  ops: (ops: Op[]) => call<{ results: { op: string; id: string; ref?: string }[] }>('POST', '/api/ops', { ops }),
};

/** Live updates over SSE: `version` bumps whenever data changes. */
export function useLive(): { version: number; connected: boolean } {
  const [version, setVersion] = useState(0);
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
    es.addEventListener('hello', () => {
      setConnected(true);
      bump();
    });
    es.addEventListener('changed', bump);
    es.onerror = () => setConnected(false);
    return () => {
      es.close();
      if (timer) clearTimeout(timer);
    };
  }, []);
  return { version, connected };
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
