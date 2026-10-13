import { Crosshair, Undo2, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { impacts } from '../shared/graph';
import type { Node } from '../shared/model';
import { api, type GraphData, remember, useLive } from './api';
import { GraphView } from './Graph';
import { NodePicker } from './NodePicker';
import { Peers } from './Peers';

interface AppState {
  graph: GraphData;
  byId: Map<string, Node>;
  /** Per task: how many tasks (transitively) need it. Missing means 0. */
  impact: Map<string, number>;
  version: number;
  focus: string | null;
  setFocus(id: string | null): void;
  /** Select a node in the graph view. */
  show(id: string): void;
  name(id: string | null | undefined): string;
  reload(): void;
  /** A short message at the bottom of the screen, with Undo when a changeset is given. */
  notify(text: string, changeset?: string): void;
  /** This instance's peer id, when federation is on. */
  selfPeer: string | null;
}

const Ctx = createContext<AppState | null>(null);
export const useApp = () => useContext(Ctx)!;

export function App() {
  const live = useLive();
  const [graph, setGraph] = useState<GraphData>({ nodes: [], edges: [] });
  const [focus, setFocusState] = useState<string | null>(() => remember.get('focus'));
  const [selected, setSelected] = useState<string | null>(null);
  const [kick, setKick] = useState(0);
  const [notice, setNotice] = useState<{ text: string; changeset?: string } | null>(null);
  const [peersOpen, setPeersOpen] = useState(false);
  const [selfPeer, setSelfPeer] = useState<string | null>(null);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 10_000);
    return () => clearTimeout(t);
  }, [notice]);

  useEffect(() => {
    api.graph().then(setGraph, () => {});
  }, [live.version, kick]);
  useEffect(() => {
    api.federation().then((s) => setSelfPeer(s.peerId ?? null), () => setSelfPeer(null));
  }, [live.version, kick]);

  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const impact = useMemo(() => impacts(graph.edges, byId), [graph, byId]);
  const setFocus = useCallback((id: string | null) => {
    setFocusState(id);
    remember.set('focus', id);
  }, []);
  const state: AppState = {
    graph,
    byId,
    impact,
    version: live.version + kick,
    focus: focus && (byId.has(focus) || !graph.nodes.length) ? focus : null,
    setFocus,
    show: setSelected,
    name: (id) => (id ? (byId.get(id)?.title ?? '(deleted)') : 'Ariadne'),
    reload: () => setKick((k) => k + 1),
    notify: (text, changeset) => setNotice({ text, ...(changeset ? { changeset } : {}) }),
    selfPeer,
  };
  const undo = async (changeset: string) => {
    try {
      await api.undo(changeset);
      setNotice({ text: 'Undone.' });
    } catch (e) {
      setNotice({ text: `Undo failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  };
  const focusNode = state.focus ? byId.get(state.focus) : undefined;

  return (
    <Ctx.Provider value={state}>
      <div className="app">
        <header className="topbar">
          <span className="brand">
            <img src="/favicon.svg" alt="" width={22} height={22} />
            Ariadne
          </span>
          <div className="focus">
            <Crosshair size={16} aria-hidden />
            {focusNode ? (
              <span className="chip focus-chip">
                {focusNode.title}
                <button className="icon" aria-label="Clear focus" onClick={() => setFocus(null)}>
                  <X size={14} />
                </button>
              </span>
            ) : (
              <NodePicker placeholder="Focus on a task…" kinds={['task']} onPick={(n) => setFocus(n.id)} />
            )}
          </div>
          <button className="btn small" onClick={() => setPeersOpen((v) => !v)}>
            Peers
          </button>
          <span className={live.connected ? 'live on' : 'live'} title={live.connected ? 'Live' : 'Reconnecting…'} />
        </header>
        {peersOpen && <Peers onClose={() => setPeersOpen(false)} />}
        <main className="main">
          <GraphView selected={selected} onSelect={setSelected} />
        </main>
        {notice && (
          <div className="toast" role="status">
            <span>{notice.text}</span>
            {notice.changeset && (
              <button className="btn small" onClick={() => undo(notice.changeset!)}>
                <Undo2 size={14} /> Undo
              </button>
            )}
            <button className="icon" aria-label="Dismiss" onClick={() => setNotice(null)}>
              <X size={14} />
            </button>
          </div>
        )}
      </div>
    </Ctx.Provider>
  );
}
