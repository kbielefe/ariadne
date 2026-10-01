import { MessagesSquare, Network, Crosshair, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { Node } from '../shared/model';
import { api, type GraphData, remember, useLive } from './api';
import { GraphView } from './Graph';
import { NodePicker } from './NodePicker';
import { TimelineView } from './Timeline';

interface AppState {
  graph: GraphData;
  byId: Map<string, Node>;
  version: number;
  focus: string | null;
  setFocus(id: string | null): void;
  /** Open a node in the graph view. */
  show(id: string): void;
  name(id: string | null | undefined): string;
  reload(): void;
  /** Put a link to this node in the chat box (and go there). */
  reference(id: string): void;
  /** References waiting to be inserted by the composer. */
  pendingRefs: string[];
  clearRefs(): void;
}

const Ctx = createContext<AppState | null>(null);
export const useApp = () => useContext(Ctx)!;

type Tab = 'timeline' | 'graph';

export function App() {
  const live = useLive();
  const [graph, setGraph] = useState<GraphData>({ nodes: [], edges: [], assignments: [] });
  const [tab, setTab] = useState<Tab>(() => (remember.get('tab') as Tab) ?? 'timeline');
  const [focus, setFocusState] = useState<string | null>(() => remember.get('focus'));
  const [selected, setSelected] = useState<string | null>(null);
  const [kick, setKick] = useState(0);
  const [pendingRefs, setPendingRefs] = useState<string[]>([]);

  useEffect(() => {
    api.graph().then(setGraph, () => {});
  }, [live.version, kick]);

  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const setFocus = useCallback((id: string | null) => {
    setFocusState(id);
    remember.set('focus', id);
  }, []);
  const go = (t: Tab) => {
    setTab(t);
    remember.set('tab', t);
  };
  const state: AppState = {
    graph,
    byId,
    version: live.version + kick,
    focus: focus && (byId.has(focus) || !graph.nodes.length) ? focus : null,
    setFocus,
    show: (id) => {
      setSelected(id);
      go('graph');
    },
    name: (id) => (id ? (byId.get(id)?.title ?? '(deleted)') : 'Ariadne'),
    reload: () => setKick((k) => k + 1),
    reference: (id) => {
      setPendingRefs((r) => [...r, id]);
      go('timeline');
    },
    pendingRefs,
    clearRefs: () => setPendingRefs([]),
  };
  const focusNode = state.focus ? byId.get(state.focus) : undefined;

  return (
    <Ctx.Provider value={state}>
      <div className="app">
        <header className="topbar">
          <span className="brand">Ariadne</span>
          <nav className="tabs" aria-label="Views">
            <button className={tab === 'timeline' ? 'tab active' : 'tab'} onClick={() => go('timeline')}>
              <MessagesSquare size={16} /> Timeline
            </button>
            <button className={tab === 'graph' ? 'tab active' : 'tab'} onClick={() => go('graph')}>
              <Network size={16} /> Graph
            </button>
          </nav>
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
          <span className={live.connected ? 'live on' : 'live'} title={live.connected ? 'Live' : 'Reconnecting…'} />
        </header>
        <main className="main">
          {tab === 'timeline' ? <TimelineView statuses={live.statuses} /> : <GraphView selected={selected} onSelect={setSelected} />}
        </main>
      </div>
    </Ctx.Provider>
  );
}
