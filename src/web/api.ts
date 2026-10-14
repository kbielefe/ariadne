import { useEffect, useState } from 'react';
import type { TaskState } from '../shared/graph';
import type { Edge, Node, NodeWithPrivate, Op } from '../shared/model';

export interface GraphData {
  nodes: Node[];
  edges: Edge[];
}
export interface NodeDetail {
  /** Only the node view carries the private notes. */
  node: NodeWithPrivate;
  edges: Edge[];
  neighbors: Node[];
  pending?: boolean;
  readiness?: { ready: boolean; waitingOn: string[]; external: string[]; state: TaskState };
}

export interface PendingOp {
  id: string;
  home: string;
  error?: string;
}

export interface FederationStatus {
  enabled: boolean;
  peerId?: string;
  announce?: string[];
  peers?: { peerId: string; label: string; offersRelay: boolean }[];
  shares?: { id: string; rootId: string; rootHome: string; members: string[] }[];
  pending?: { id: string; home: string }[];
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
  ops: (ops: Op[]) => call<{ results: { op: string; id: string; ref?: string }[]; changeset: string; pending?: PendingOp[]; nowReady?: { id: string; title: string }[] }>('POST', '/api/ops', { ops }),
  undo: (changeset: string) => call<{ undone: number }>('POST', '/api/undo', { changeset }),
  federation: () => call<FederationStatus>('GET', '/api/federation'),
  invite: (via: 'direct' | 'relay') => call<{ invite: string }>('POST', '/api/federation/invite', { via }),
  acceptInvite: (invite: string) => call<{ ok: boolean }>('POST', '/api/federation/accept', { invite }),
  share: (rootId: string, peerId: string) => call<{ id: string }>('POST', '/api/federation/share', { rootId, peerId }),
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
