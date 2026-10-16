import { Search, Undo2, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { type Direction, impacts } from '../shared/graph';
import type { Node } from '../shared/model';
import { api, type GraphData, remember, useLive } from './api';
import { GraphView } from './Graph';
import { NodePicker } from './NodePicker';
import { back, focusStep, forward, parseSteps, record, type Step, type StepHistory } from './steps';

interface AppState {
  graph: GraphData;
  byId: Map<string, Node>;
  /** Per task: how many tasks (transitively) need it. Missing means 0. */
  impact: Map<string, number>;
  version: number;
  /** The graph view's filter steps, re-applied on every change. */
  steps: Step[];
  /** Change the steps (one entry in back/forward). */
  setSteps(steps: Step[]): void;
  canBack: boolean;
  canForward: boolean;
  back(): void;
  forward(): void;
  /** Select a node in the graph view. */
  show(id: string): void;
  /** Make sure a node is drawn (once it exists), adding it to the view if the steps hide it. */
  reveal(id: string): void;
  revealing: string | null;
  doneRevealing(): void;
  name(id: string | null | undefined): string;
  reload(): void;
  /** A short message at the bottom of the screen, with Undo when a changeset is given. */
  notify(text: string, changeset?: string): void;
}

const Ctx = createContext<AppState | null>(null);
export const useApp = () => useContext(Ctx)!;

export function App() {
  const live = useLive();
  const [graph, setGraph] = useState<GraphData>({ nodes: [], edges: [] });
  const [history, setHistory] = useState<StepHistory>(() => ({ past: [], now: loadSteps(), future: [] }));
  const [selection, setSelection] = useState<string[]>([]);
  const [revealing, setRevealing] = useState<string | null>(null);
  const [kick, setKick] = useState(0);
  const [notice, setNotice] = useState<{ text: string; changeset?: string } | null>(null);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 10_000);
    return () => clearTimeout(t);
  }, [notice]);

  useEffect(() => {
    api.graph().then(setGraph, () => {});
  }, [live.version, kick]);

  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const impact = useMemo(() => impacts(graph.edges, byId), [graph, byId]);
  const moveTo = useCallback((change: (h: StepHistory) => StepHistory) => {
    setHistory((h) => {
      const next = change(h);
      if (next.now !== h.now) remember.set('graphSteps', JSON.stringify(next.now));
      return next;
    });
  }, []);
  // Deleted nodes leave the selection.
  const selected = useMemo(() => (graph.nodes.length ? selection.filter((id) => byId.has(id)) : selection), [selection, byId, graph]);
  const state: AppState = {
    graph,
    byId,
    impact,
    version: live.version + kick,
    steps: history.now,
    setSteps: (steps) => moveTo((h) => record(h, steps)),
    canBack: history.past.length > 0,
    canForward: history.future.length > 0,
    back: () => moveTo(back),
    forward: () => moveTo(forward),
    show: (id) => setSelection([id]),
    reveal: setRevealing,
    revealing,
    doneRevealing: () => setRevealing(null),
    name: (id) => (id ? (byId.get(id)?.title ?? '(deleted)') : 'Ariadne'),
    reload: () => setKick((k) => k + 1),
    notify: (text, changeset) => setNotice({ text, ...(changeset ? { changeset } : {}) }),
  };
  const undo = async (changeset: string) => {
    try {
      await api.undo(changeset);
      setNotice({ text: 'Undone.' });
    } catch (e) {
      setNotice({ text: `Undo failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  return (
    <Ctx.Provider value={state}>
      <div className="app">
        <header className="topbar">
          <span className="brand">
            <img src="/favicon.svg" alt="" width={22} height={22} />
            Ariadne
          </span>
          <div className="find">
            <Search size={16} aria-hidden />
            <NodePicker
              placeholder="Find…"
              onPick={(n) => {
                setSelection([n.id]);
                setRevealing(n.id);
              }}
            />
          </div>
          <span className={live.connected ? 'live on' : 'live'} title={live.connected ? 'Live' : 'Reconnecting…'} />
        </header>
        <main className="main">
          <GraphView selection={selected} onSelection={setSelection} />
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

/** Saved steps; before steps existed, the saved focus (with its direction and depth) becomes the first one. */
function loadSteps(): Step[] {
  const saved = remember.get('graphSteps');
  if (saved != null) return parseSteps(saved);
  const focus = remember.get('focus');
  if (!focus) return [];
  let f: { direction?: Direction; depth?: number } = {};
  try {
    f = JSON.parse(remember.get('graphFilters') ?? '{}') as typeof f;
  } catch {
    /* defaults */
  }
  const steps = [focusStep(crypto.randomUUID(), focus, f.direction, f.depth)];
  remember.set('graphSteps', JSON.stringify(steps));
  remember.set('focus', null);
  return steps;
}
