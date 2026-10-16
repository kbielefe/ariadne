import cytoscape, { type Core as Cy, type ElementDefinition } from 'cytoscape';
import fcose from 'cytoscape-fcose';
import { ArrowDownUp, Eye, EyeOff, Maximize, Network, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Plus, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { readiness, taskState } from '../shared/graph';
import { EDGE_RULES, type EdgeKind, EdgeKind as EdgeKinds, type NodeKind, USER_ID } from '../shared/model';
import { remember } from './api';
import { useApp } from './App';
import { KindIcon } from './bits';
import { NewNodeForm, NodePanel } from './NodePanel';
import { type Body, nudgeStep } from './nudge';
import { NODE_SIZE, placeNew, type View, loadView, saveView } from './placement';
import { DEFAULT_LAYOUT, isLayout, LAYOUTS, layered, type LayoutEdge, type LayoutName, type LayoutNode, radial } from './layouts';
import { DEFAULT_SORT, isSort, SORTS, type Sort, sortNodes } from './order';
import { ALL, applySteps, centre, shownSeeds, type StepGraph, stepsKey } from './steps';
import { newStep, StepsPanel, withStep } from './StepsPanel';

cytoscape.use(fcose);

const NODE_KINDS: NodeKind[] = ['task', 'person', 'team', 'resource'];

interface Filters {
  kinds: NodeKind[];
  edges: EdgeKind[];
  /** The edge kinds that existed when these filters were saved: kinds added since start shown. */
  knownEdges: EdgeKind[];
  showClosed: boolean;
  showImpact: boolean;
}

// Filters saved before knownEdges existed predate working_on.
const LEGACY_EDGES = EdgeKinds.options.filter((k) => k !== 'working_on');
const DEFAULT_FILTERS: Filters = { kinds: NODE_KINDS, edges: [...EdgeKinds.options], knownEdges: [...EdgeKinds.options], showClosed: false, showImpact: false };

function loadSort(): Sort {
  const s = remember.get('graphSort');
  return isSort(s) ? s : DEFAULT_SORT;
}

function loadLayout(): LayoutName {
  const s = remember.get('graphLayout');
  return isLayout(s) ? s : DEFAULT_LAYOUT;
}

function loadBends(): boolean {
  return remember.get('graphBends') !== 'off';
}

function loadFilters(): Filters {
  try {
    // direction and depth belonged to the old focus; they live on in its step (see App's loadSteps).
    const { direction: _d, depth: _n, ...saved } = JSON.parse(remember.get('graphFilters') ?? '{}') as Partial<Filters> & { direction?: unknown; depth?: unknown };
    const f: Filters = { ...DEFAULT_FILTERS, ...saved };
    const known = saved.edges ? (saved.knownEdges ?? LEGACY_EDGES) : EdgeKinds.options;
    const edges = [...f.edges.filter((k) => EdgeKinds.options.includes(k)), ...EdgeKinds.options.filter((k) => !known.includes(k) && !f.edges.includes(k))];
    return { ...f, kinds: f.kinds.filter((k) => NODE_KINDS.includes(k)), edges, knownEdges: [...EdgeKinds.options] };
  } catch {
    return DEFAULT_FILTERS;
  }
}

export function GraphView({ selection, onSelection }: { selection: string[]; onSelection(ids: string[]): void }) {
  const { graph, byId, impact, steps, setSteps, reveal, revealing, doneRevealing } = useApp();
  const [f, setF] = useState<Filters>(loadFilters);
  // The New form, and the task it will be needed by (the selected task when you pressed New).
  const [creating, setCreating] = useState<{ parent: string | null } | null>(null);
  // The details pane shows the node selected last.
  const selected = selection.at(-1) ?? null;
  const onSelect = (id: string | null) => onSelection(id ? [id] : []);
  const [sort, setSortState] = useState<Sort>(loadSort);
  const setSort = (x: Sort) => {
    setSortState(x);
    remember.set('graphSort', x);
  };
  const [layout, setLayoutState] = useState<LayoutName>(loadLayout);
  const setLayout = (x: LayoutName) => {
    setLayoutState(x);
    remember.set('graphLayout', x);
  };
  const [bends, setBendsState] = useState(loadBends);
  const setBends = (on: boolean) => {
    setBendsState(on);
    remember.set('graphBends', on ? 'on' : 'off');
  };
  const [panes, setPanes] = useState<Panes>(() => {
    try {
      return { ...DEFAULT_PANES, ...JSON.parse(remember.get('graphPanes') ?? '{}') };
    } catch {
      return DEFAULT_PANES;
    }
  });
  const [dragging, setDragging] = useState(false);
  // Selecting something (here, or from a node chip) brings the details back.
  useEffect(() => {
    if (selected) setPanes((x) => (x.details ? x : { ...x, details: true }));
  }, [selected]);
  const setPane = (p: Partial<Panes>) =>
    setPanes((x) => {
      const next = { ...x, ...p };
      remember.set('graphPanes', JSON.stringify(next));
      return next;
    });
  const update = (p: Partial<Filters>) =>
    setF((x) => {
      const next = { ...x, ...p };
      remember.set('graphFilters', JSON.stringify(next));
      return next;
    });

  // What to draw: kind and status filters, then the steps. Both re-run on every graph change.
  const edges = useMemo(() => graph.edges.filter((e) => f.edges.includes(e.kind)), [graph, f.edges]);
  const g: StepGraph = useMemo(() => ({ edges: graph.edges, byId }), [graph, byId]);
  const base = useMemo(() => new Set(graph.nodes.filter((n) => f.kinds.includes(n.kind) && (f.showClosed || (n.status !== 'done' && n.status !== 'dropped'))).map((n) => n.id)), [graph, f.kinds, f.showClosed]);
  const shown = useMemo(() => applySteps(base, steps, g), [base, steps, g]);
  const elements = useMemo(() => {
    const ids = shown;
    const seeds = shownSeeds(steps, g);
    const els: ElementDefinition[] = [];
    // Elements carry their place in the sort; the layout lays siblings out in that order.
    const order = new Map(sortNodes([...ids].map((id) => byId.get(id)!), sort, graph.edges, byId).map((n, i) => [n.id, i]));
    for (const id of order.keys()) {
      const n = byId.get(id)!;
      const classes: string[] = [n.kind];
      if (n.kind === 'task') {
        classes.push(n.status ?? 'open');
        if (n.status === 'open') {
          classes.push(taskState(readiness(n, graph.edges, byId)));
        }
        if (!graph.edges.some((e) => e.kind === 'needs' && e.dst === id)) classes.push('root');
      }
      if (seeds.has(id)) classes.push('seed');
      const label = n.title.length > 64 ? `${n.title.slice(0, 63)}…` : n.title;
      // The canvas draws this as a badge on the node's top-right corner.
      const badge = f.showImpact && n.kind === 'task' ? (impact.get(id) ?? 0) : undefined;
      els.push({ group: 'nodes', data: { id, label, title: n.title, order: order.get(id), badge }, classes: classes.join(' ') });
    }
    for (const e of edges) if (ids.has(e.src) && ids.has(e.dst)) els.push({ group: 'edges', data: { id: e.id, source: e.src, target: e.dst, label: e.kind === 'needs' ? '' : EDGE_RULES[e.kind].label, order: order.get(e.dst) }, classes: e.kind === 'waits_on' && e.dst === USER_ID ? `${e.kind} to-you` : e.kind });
    return els;
  }, [graph, byId, impact, f.showImpact, shown, steps, g, edges, sort]);

  // Each view remembers its own arrangement.
  const viewKey = [layout, sort, stepsKey(steps)].join('|');
  const radialCentre = centre(steps, g);

  // Found or just created: once the node exists, make sure it's drawn.
  useEffect(() => {
    if (!revealing || !byId.has(revealing)) return;
    doneRevealing();
    if (shown.has(revealing)) return;
    const n = byId.get(revealing)!;
    const closed = n.status === 'done' || n.status === 'dropped';
    if (!f.kinds.includes(n.kind) || (closed && !f.showClosed)) update({ kinds: f.kinds.includes(n.kind) ? f.kinds : [...f.kinds, n.kind], showClosed: f.showClosed || closed });
    if (!applySteps(new Set([revealing]), steps, g).has(revealing)) setSteps([...steps, newStep('union', { type: 'nodes', ids: [revealing] })]);
  }, [revealing, byId, shown]);

  const showTree = (id: string) => setSteps(withStep(steps, newStep('replace', { type: 'nodes', ids: [id] }, { up: 0, down: ALL })));

  const counts = useMemo(() => ({ shown: elements.filter((e) => e.group === 'nodes').length, total: graph.nodes.length }), [elements, graph]);

  return (
    <div className={`graph-view ${dragging ? 'dragging' : ''}`} style={{ gridTemplateColumns: `${panes.filters ? `${panes.filtersW}px` : '0px'} 1fr ${panes.details ? `${panes.detailsW}px` : '0px'}` }}>
      <aside className="filters" aria-label="Filters" hidden={!panes.filters}>
        <fieldset>
          <legend>Show</legend>
          {NODE_KINDS.map((k) => (
            <label key={k} className="check">
              <input type="checkbox" checked={f.kinds.includes(k)} onChange={(e) => update({ kinds: e.target.checked ? [...f.kinds, k] : f.kinds.filter((x) => x !== k) })} />
              <KindIcon kind={k} /> {k}
            </label>
          ))}
          <label className="check">
            <input type="checkbox" checked={f.showClosed} onChange={(e) => update({ showClosed: e.target.checked })} /> done &amp; dropped
          </label>
          <label className="check" title="How many tasks (directly or indirectly) need each task">
            <input type="checkbox" checked={f.showImpact} onChange={(e) => update({ showImpact: e.target.checked })} /> impact on tasks
          </label>
        </fieldset>
        <fieldset>
          <legend>Edges</legend>
          {EdgeKinds.options.map((k) => (
            <label key={k} className="check">
              <input type="checkbox" checked={f.edges.includes(k)} onChange={(e) => update({ edges: e.target.checked ? [...f.edges, k] : f.edges.filter((x) => x !== k) })} /> {EDGE_RULES[k].label}
            </label>
          ))}
        </fieldset>
        <StepsPanel selection={selection} />
        <fieldset>
          <legend>
            <Network size={12} /> Layout
          </legend>
          <select value={layout} onChange={(e) => setLayout(e.target.value as LayoutName)} aria-label="Layout">
            {Object.entries(LAYOUTS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
          <label className="check" title={layout === 'layered' ? 'Route edges around the nodes they pass, instead of straight through' : 'Only the layered layout routes edges'}>
            <input type="checkbox" checked={bends} disabled={layout !== 'layered'} onChange={(e) => setBends(e.target.checked)} /> bend edges
          </label>
          {layout === 'force' && <p className="muted small">Drag a node: linked nodes follow, and nodes in the way move aside.</p>}
        </fieldset>
        <fieldset>
          <legend>
            <ArrowDownUp size={12} /> Order
          </legend>
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Order of nodes side by side">
            {Object.entries(SORTS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </fieldset>
        <p className="muted small">
          {counts.shown} of {counts.total} shown. Click to select; ctrl- or shift-click to add; drag to box-select (shift adds). Middle-drag to pan, scroll to zoom. Double-click shows a node and all its children.
        </p>
      </aside>
      <div className="canvas-wrap">
        <Canvas elements={elements} viewKey={viewKey} arrange={arrangers[layout](radialCentre)} bends={bends && layout === 'layered'} nudge={layout === 'force'} selection={selection} onSelection={onSelection} onOpen={showTree} />
        <div className="canvas-tools">
          <button className="btn icon-btn" aria-label={panes.filters ? 'Hide filters' : 'Show filters'} aria-pressed={panes.filters} title={panes.filters ? 'Hide filters' : 'Show filters'} onClick={() => setPane({ filters: !panes.filters })}>
            {panes.filters ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
          </button>
          <button
            className="btn primary"
            onClick={() => {
              setCreating({ parent: selected && byId.get(selected)?.kind === 'task' ? selected : null });
              onSelect(null);
              setPane({ details: true });
            }}
          >
            <Plus size={16} /> New
          </button>
          {selection.length > 0 && (
            <>
              <button className="btn" title="Hide the selected nodes (a Hide step)" onClick={() => {
                setSteps(withStep(steps, newStep('subtract', { type: 'nodes', ids: selection })));
                onSelection([]);
              }}>
                <EyeOff size={16} /> Hide{selection.length > 1 ? ` ${selection.length}` : ''}
              </button>
              <button className="btn" title="Show only the selected nodes (starts new steps)" onClick={() => setSteps(withStep(steps, newStep('replace', { type: 'nodes', ids: selection })))}>
                <Eye size={16} /> Only {selection.length > 1 ? 'these' : 'this'}
              </button>
            </>
          )}
        </div>
        {panes.filters && <ResizeHandle side="left" label="Resize filters" width={panes.filtersW} min={160} max={420} fallback={DEFAULT_PANES.filtersW} onChange={(filtersW) => setPane({ filtersW })} onDrag={setDragging} />}
        {panes.details && <ResizeHandle side="right" label="Resize details" width={panes.detailsW} min={280} max={900} fallback={DEFAULT_PANES.detailsW} onChange={(detailsW) => setPane({ detailsW })} onDrag={setDragging} />}
        <button className="btn icon-btn pane-toggle" aria-label={panes.details ? 'Hide details' : 'Show details'} aria-pressed={panes.details} title={panes.details ? 'Hide details' : 'Show details'} onClick={() => setPane({ details: !panes.details })}>
          {panes.details ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
        </button>
      </div>
      <aside className="panel" aria-label="Details" hidden={!panes.details}>
        {selected && byId.has(selected) ? (
          <NodePanel
            id={selected}
            onSelect={onSelect}
            selectionCount={selection.length}
            onShowTree={() => showTree(selected!)}
            onHide={() => {
              setSteps(withStep(steps, newStep('subtract', { type: 'nodes', ids: [selected!] })));
              onSelect(null);
            }}
            onClose={() => {
              onSelect(null);
              setPane({ details: false });
            }}
          />
        ) : creating || !graph.nodes.length ? (
          <NewNodeForm
            parent={creating?.parent ?? null}
            onCreated={(id) => {
              setCreating(null);
              onSelect(id);
              reveal(id);
            }}
          />
        ) : (
          <div className="panel-empty">
            <p>Select something to see and edit it, or use “+ New”.</p>
          </div>
        )}
      </aside>
    </div>
  );
}

interface Panes {
  filters: boolean;
  details: boolean;
  filtersW: number;
  detailsW: number;
}
const DEFAULT_PANES: Panes = { filters: true, details: true, filtersW: 210, detailsW: 380 };

/** A draggable (and arrow-key operable) divider on the canvas edge next to a sidebar. */
function ResizeHandle(p: { side: 'left' | 'right'; label: string; width: number; min: number; max: number; fallback: number; onChange(w: number): void; onDrag(on: boolean): void }) {
  const clamp = (w: number) => Math.round(Math.min(p.max, Math.max(p.min, w)));
  // The left sidebar grows as you drag right; the right one grows as you drag left.
  const sign = p.side === 'left' ? 1 : -1;
  return (
    <div
      className={`resize-handle ${p.side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={p.label}
      aria-valuenow={p.width}
      aria-valuemin={p.min}
      aria-valuemax={p.max}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      onDoubleClick={() => p.onChange(p.fallback)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 60 : 20;
        if (e.key === 'ArrowLeft') p.onChange(clamp(p.width - sign * step));
        else if (e.key === 'ArrowRight') p.onChange(clamp(p.width + sign * step));
        else return;
        e.preventDefault();
      }}
      onPointerDown={(e) => {
        e.preventDefault();
        const startX = e.clientX;
        const start = p.width;
        p.onDrag(true);
        const move = (m: PointerEvent) => p.onChange(clamp(start + sign * (m.clientX - startX)));
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          p.onDrag(false);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }}
    />
  );
}

function css(name: string, fallback: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function styles(): cytoscape.StylesheetJson {
  const fg = css('--fg', '#1d2330');
  const muted = css('--muted', '#6b7280');
  const line = css('--line', '#c9ced8');
  const surface = css('--surface', '#ffffff');
  const accent = css('--accent', '#2563eb');
  const good = css('--good', '#15803d');
  const blocked = css('--blocked', '#ca8a04');
  const blockedSoft = css('--blocked-soft', '#fef9c3');
  const yours = css('--yours', '#7c3aed');
  const yoursSoft = css('--yours-soft', '#ede9fe');
  const theirs = css('--theirs', '#64748b');
  const theirsSoft = css('--theirs-soft', '#eef1f5');
  return [
    {
      selector: 'node',
      style: {
        label: 'data(label)',
        'text-wrap': 'wrap',
        'text-max-width': '160px',
        'font-size': 12,
        color: fg,
        'text-valign': 'center',
        'text-halign': 'center',
        'background-color': surface,
        'border-width': 1.5,
        'border-color': line,
        width: NODE_SIZE.task.w,
        height: NODE_SIZE.task.h,
        shape: 'round-rectangle',
      },
    },
    { selector: 'node.task.ready', style: { 'border-color': good, 'border-width': 2.5 } },
    { selector: 'node.task.waiting', style: { 'border-style': 'dashed' } },
    // Blocked outside the user's control (a review, a CI build, a merge): yellow, so it stands out from waiting on subtasks.
    { selector: 'node.task.blocked', style: { 'border-color': blocked, 'border-width': 3, 'background-color': blockedSoft } },
    // Waits only on you (a review, a decision): violet, so your queue stands out from what an agent can take (green).
    { selector: 'node.task.yours', style: { 'border-color': yours, 'border-width': 3, 'background-color': yoursSoft } },
    // Someone else is working on it (a teammate's intent): muted and dotted, so it reads as context, not work for you.
    { selector: 'node.task.theirs', style: { 'border-color': theirs, 'border-style': 'dotted', 'border-width': 2.5, 'background-color': theirsSoft, color: theirs } },
    { selector: 'node.task.root', style: { 'font-weight': 'bold', 'border-width': 3 } },
    { selector: 'node.task.done, node.task.dropped', style: { color: muted, opacity: 0.6 } },
    { selector: 'node.task.dropped', style: { 'text-decoration': 'line-through' } as never },
    { selector: 'node.person', style: { shape: 'ellipse', width: NODE_SIZE.person.w, 'background-color': css('--person', '#eef2ff') } },
    { selector: 'node.team', style: { shape: 'octagon', width: NODE_SIZE.team.w, 'background-color': css('--team', '#fef3c7') } },
    { selector: 'node.resource', style: { shape: 'tag', width: NODE_SIZE.resource.w, 'background-color': css('--resource', '#f3f4f6') } },
    // Picked by hand in a step that shows it (what double-click shows, say).
    { selector: 'node.seed', style: { 'border-color': accent, 'border-width': 4 } },
    { selector: 'node:selected', style: { 'overlay-color': accent, 'overlay-opacity': 0.15, 'overlay-padding': 6 } },
    {
      selector: 'edge',
      style: {
        width: 1.5,
        'line-color': line,
        'target-arrow-color': line,
        'target-arrow-shape': 'triangle',
        'curve-style': 'bezier',
        label: 'data(label)',
        'font-size': 10,
        color: muted,
        'text-background-color': surface,
        'text-background-opacity': 1,
        'text-background-padding': '2px',
      },
    },
    { selector: 'edge.needs', style: { width: 2, 'line-color': muted, 'target-arrow-color': muted } },
    { selector: 'edge.uses', style: { 'line-style': 'dashed' } },
    { selector: 'edge.involves', style: { 'line-style': 'dotted' } },
    { selector: 'edge.waits_on', style: { width: 2.5, 'line-color': blocked, 'target-arrow-color': blocked, color: blocked } },
    { selector: 'edge.waits_on.to-you', style: { 'line-color': yours, 'target-arrow-color': yours, color: yours } },
    { selector: 'edge.working_on', style: { width: 2, 'line-style': 'dashed', 'line-color': theirs, 'target-arrow-color': theirs, color: theirs } },
    { selector: 'edge:selected', style: { 'line-color': accent, 'target-arrow-color': accent, width: 3 } },
  ];
}

/** Lays out every node from scratch and returns where they go. */
type Arrange = (c: Cy) => Promise<View>;

/** What a layout needs to know about the drawn graph. */
function layoutInput(c: Cy): { nodes: LayoutNode[]; edges: LayoutEdge[] } {
  return {
    nodes: c.nodes().map((n) => ({ id: n.id(), kind: kindOf(n), order: n.data('order') as number })),
    edges: c.edges().map((e) => ({ id: e.id(), src: e.data('source') as string, dst: e.data('target') as string, kind: e.classes()[0] as EdgeKind })),
  };
}

const FORCE_EDGE = NODE_SIZE.task.w;

const arrangers: Record<LayoutName, (centre: string | null) => Arrange> = {
  layered: () => (c) => {
    const { nodes, edges } = layoutInput(c);
    return layered(nodes, edges);
  },
  radial: (centre) => async (c) => {
    const { nodes, edges } = layoutInput(c);
    return radial(nodes, edges, centre);
  },
  // fcose moves the nodes itself; read back where they went.
  force: () => (c) =>
    new Promise((resolve) => {
      const l = c.layout({ name: 'fcose', quality: 'proof', randomize: true, animate: false, fit: false, nodeDimensionsIncludeLabels: false, idealEdgeLength: FORCE_EDGE, nodeRepulsion: 20000, nodeSeparation: 60, packComponents: true } as cytoscape.LayoutOptions);
      l.one('layoutstop', () => resolve({ flow: { x: 0, y: FORCE_EDGE }, pos: new Map(c.nodes().map((n) => [n.id(), { ...n.position() }])) }));
      l.run();
    }),
};

function fitView(c: Cy) {
  c.fit(undefined, 30);
  // A handful of nodes shouldn't fill the screen.
  if (c.zoom() > 1.1) {
    c.zoom(1.1);
    c.center();
  }
}

const BEND_STYLE = 'curve-style edge-distances segment-weights segment-distances segment-radius';

/** Draw edges along their bend points (with rounded corners), or straight when `on` is false. */
function drawBends(c: Cy, v: View | undefined, on: boolean) {
  c.batch(() =>
    c.edges().forEach((e) => {
      const b = on ? v?.bends?.get(e.id()) : undefined;
      if (b) e.style({ 'curve-style': 'round-segments', 'edge-distances': 'node-position', 'segment-weights': b.w, 'segment-distances': b.d, 'segment-radius': 30 } as never);
      else e.removeStyle(BEND_STYLE);
    }),
  );
}

interface Nudging {
  held: string;
  bodies: Map<string, Body>;
  edges: { src: string; dst: string }[];
  touched: Set<string>;
  released: boolean;
  after: number;
  raf: number;
}

function Canvas(p: { elements: ElementDefinition[]; viewKey: string; arrange: Arrange; bends: boolean; nudge: boolean; selection: string[]; onSelection(ids: string[]): void; onOpen(id: string): void }) {
  const { elements, viewKey, selection, bends } = p;
  const box = useRef<HTMLDivElement>(null);
  const cy = useRef<Cy | null>(null);
  const handlers = useRef({ selection, onSelection: p.onSelection, onOpen: p.onOpen, arrange: p.arrange, bends: p.bends, nudge: p.nudge });
  handlers.current = { selection, onSelection: p.onSelection, onOpen: p.onOpen, arrange: p.arrange, bends: p.bends, nudge: p.nudge };
  // The arrangement on screen; nodes keep these positions until the view changes or you re-arrange.
  const view = useRef<{ key: string; v: View } | null>(null);
  const runs = useRef(0);
  const [rearranged, setRearranged] = useState(0);
  const handled = useRef(0);
  const badges = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Cytoscape does the selecting: click selects one, ctrl/shift/cmd-click toggles, dragging on the background
    // box-selects (with shift, adds to the selection). Its own drag-to-pan is off: the middle button pans (below).
    const c = cytoscape({ container: box.current!, style: styles(), wheelSensitivity: 1.5, minZoom: 0.15, maxZoom: 2.5, boxSelectionEnabled: true, userPanningEnabled: false });
    // Middle-button drag pans. Caught on the window before cytoscape sees it: it would take the release for a
    // left click on the background and clear the selection.
    let panFrom: { x: number; y: number } | null = null;
    const panDown = (e: MouseEvent) => {
      if (e.button !== 1 || !box.current?.contains(e.target as Element)) return;
      e.preventDefault(); // no autoscroll
      e.stopImmediatePropagation();
      panFrom = { x: e.clientX, y: e.clientY };
      box.current.classList.add('panning');
    };
    const panMove = (e: MouseEvent) => {
      if (!panFrom) return;
      e.stopImmediatePropagation();
      c.panBy({ x: e.clientX - panFrom.x, y: e.clientY - panFrom.y });
      panFrom = { x: e.clientX, y: e.clientY };
    };
    const panUp = (e: MouseEvent) => {
      if (!panFrom || e.button !== 1) return;
      e.preventDefault(); // no paste on Linux
      e.stopImmediatePropagation();
      panFrom = null;
      box.current?.classList.remove('panning');
    };
    window.addEventListener('mousedown', panDown, true);
    window.addEventListener('mousemove', panMove, true);
    window.addEventListener('mouseup', panUp, true);
    // Pass its node selection up once per gesture, in the order picked (so the last one picked shows in the details).
    let syncing = false;
    c.on('select unselect', 'node', () => {
      if (syncing) return;
      syncing = true;
      queueMicrotask(() => {
        syncing = false;
        const now = new Set(c.nodes(':selected').map((n) => n.id()));
        const prev = handlers.current.selection;
        if (now.size === prev.length && prev.every((id) => now.has(id))) return;
        handlers.current.onSelection([...prev.filter((id) => now.has(id)), ...[...now].filter((id) => !prev.includes(id))]);
      });
    });
    c.on('dbltap', 'node', (e) => handlers.current.onOpen(e.target.id()));
    // A node you drag stays where you put it. Its edges forget their bends, which no longer fit.
    let nudging: Nudging | null = null;
    // Remember where the nudged nodes are now (on release, and again once they settle).
    const keep = () => {
      const cur = view.current;
      if (!cur || !nudging) return;
      for (const id of nudging.touched) cur.v.pos.set(id, { ...c.getElementById(id).position() });
      saveView(cur.key, cur.v);
    };
    const finish = () => {
      if (!nudging) return;
      cancelAnimationFrame(nudging.raf);
      keep();
      nudging = null;
    };
    // Force layout: each frame, followers and bumped nodes take one step; after you let go, they settle.
    const tick = () => {
      const s = nudging!;
      const held = c.getElementById(s.held);
      if (held.empty()) return finish();
      Object.assign(s.bodies.get(s.held)!, held.position());
      const { moved, most } = nudgeStep(s.bodies, s.edges, s.held, { edge: FORCE_EDGE });
      c.batch(() => {
        for (const id of moved) {
          const b = s.bodies.get(id)!;
          c.getElementById(id).position({ x: b.x, y: b.y });
          s.touched.add(id);
        }
      });
      if (s.released && (most < 0.3 || ++s.after > 90)) return finish();
      s.raf = requestAnimationFrame(tick);
    };
    c.on('drag', 'node', (e) => {
      const id = e.target.id() as string;
      const cur = view.current;
      const bent = e.target.connectedEdges().filter((x: cytoscape.EdgeSingular) => cur?.v.bends?.has(x.id()));
      if (bent.nonempty()) {
        bent.forEach((x: cytoscape.EdgeSingular) => void cur!.v.bends!.delete(x.id()));
        bent.removeStyle(BEND_STYLE);
      }
      // Dragging several selected nodes moves them together; nudging follows only a single node.
      if (!handlers.current.nudge || nudging?.held === id || c.nodes(':grabbed').length > 1) return;
      finish();
      const bodies = new Map(c.nodes().map((n) => [n.id(), { ...n.position(), ...NODE_SIZE[kindOf(n)], vx: 0, vy: 0 }]));
      const edges = c.edges().map((x) => ({ src: x.data('source') as string, dst: x.data('target') as string }));
      nudging = { held: id, bodies, edges, touched: new Set(), released: false, after: 0, raf: requestAnimationFrame(tick) };
    });
    c.on('dragfree', 'node', (e) => {
      if (nudging && nudging.held === e.target.id()) nudging.released = true;
      if (!view.current) return;
      view.current.v.pos.set(e.target.id(), { ...e.target.position() });
      if (nudging) keep();
      else saveView(view.current.key, view.current.v);
    });
    // Badges are HTML over the canvas (cytoscape can't draw outside a node); follow every redraw.
    c.on('render', () => placeBadges(c, badges.current!));
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const restyle = () => c.style(styles());
    mq.addEventListener('change', restyle);
    cy.current = c;
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(box.current!);
    return () => {
      finish();
      window.removeEventListener('mousedown', panDown, true);
      window.removeEventListener('mousemove', panMove, true);
      window.removeEventListener('mouseup', panUp, true);
      ro.disconnect();
      mq.removeEventListener('change', restyle);
      c.destroy();
    };
  }, []);

  // Patch elements in place, then position only what needs it.
  useEffect(() => {
    const c = cy.current!;
    const want = new Map(elements.map((e) => [e.data.id!, e]));
    const before = new Set(c.nodes().map((n) => n.id()));
    c.batch(() => {
      c.elements().forEach((el) => {
        if (!want.has(el.id())) el.remove();
      });
      for (const e of elements) {
        const el = c.getElementById(e.data.id!);
        if (el.nonempty()) {
          el.data(e.data);
          el.classes(e.classes as string);
        } else c.add(e);
      }
    });
    const apply = (v: View) => {
      c.batch(() =>
        c.nodes().forEach((n) => {
          const at = v.pos.get(n.id());
          if (at) n.position({ ...at });
        }),
      );
      drawBends(c, v, handlers.current.bends);
    };
    // Nodes this view hasn't placed yet go beside their neighbours.
    const placeRest = (cur: { key: string; v: View }) => {
      const ids = c.nodes().map((n) => n.id());
      const edges = c.edges().map((e) => ({ src: e.data('source') as string, dst: e.data('target') as string }));
      const size = (id: string) => NODE_SIZE[kindOf(c.getElementById(id))];
      const visible = new Map([...cur.v.pos].filter(([id]) => want.has(id)));
      const added = placeNew(ids, edges, visible, size, cur.v.flow);
      for (const [id, at] of added) cur.v.pos.set(id, at);
      apply(cur.v);
      if (added.size) saveView(cur.key, cur.v);
    };

    const forced = rearranged !== handled.current;
    handled.current = rearranged;
    const ids = [...want.values()].filter((e) => e.group === 'nodes');
    // Nothing to draw yet (say, still loading): arrange once there is.
    if (!ids.length) return;
    const cur = view.current;
    if (!forced && cur?.key === viewKey && ids.some((e) => cur.v.pos.has(e.data.id!))) {
      placeRest(cur);
      return;
    }
    // A new view: use what it remembers if that covers most of it; else, after a small change to the steps
    // (most of what was drawn stays, and most of what is drawn was there), keep nodes where they are on screen;
    // otherwise lay it out.
    const covers = (v: View) => ids.filter((e) => v.pos.has(e.data.id!)).length * 2 >= ids.length;
    const saved = forced ? null : loadView(viewKey);
    const stayed = ids.filter((e) => before.has(e.data.id!)).length;
    const small = stayed * 2 >= Math.max(before.size, ids.length);
    const kept = !forced && !saved && cur && small ? { flow: cur.v.flow, pos: new Map(cur.v.pos), ...(cur.v.bends ? { bends: new Map(cur.v.bends) } : {}) } : null;
    const reuse = saved && covers(saved) ? saved : kept;
    if (reuse) {
      view.current = { key: viewKey, v: reuse };
      placeRest(view.current);
      if (kept) saveView(viewKey, kept);
      fitView(c);
      return;
    }
    const run = ++runs.current;
    void handlers.current.arrange(c).then((v) => {
      if (run !== runs.current) return;
      view.current = { key: viewKey, v };
      apply(v);
      saveView(viewKey, v);
      fitView(c);
    });
  }, [elements, viewKey, rearranged]);

  useEffect(() => drawBends(cy.current!, view.current?.v, bends), [bends]);

  // Selection from elsewhere (a node chip, Find, New): select just those nodes.
  useEffect(() => {
    const c = cy.current!;
    const want = new Set(selection);
    c.batch(() =>
      c.nodes().forEach((n) => {
        if (want.has(n.id()) !== n.selected()) (want.has(n.id()) ? n.select() : n.unselect());
      }),
    );
  }, [selection, elements]);

  return (
    <>
      <div ref={box} className="canvas" role="img" aria-label="Graph of tasks, people, teams, and resources" />
      <div ref={badges} className="badges" aria-hidden />
      <div className="canvas-view-tools">
        <button className="icon" aria-label="Re-arrange" title="Re-arrange: lay this view out from scratch, forgetting where nodes were" onClick={() => setRearranged((x) => x + 1)}>
          <RefreshCw size={16} />
        </button>
        <button className="icon" aria-label="Fit to screen" title="Fit to screen" onClick={() => cy.current?.animate({ fit: { eles: cy.current.elements(), padding: 30 } }, { duration: 200 })}>
          <Maximize size={16} />
        </button>
      </div>
    </>
  );
}

const kindOf = (n: cytoscape.NodeSingular): NodeKind => NODE_KINDS.find((k) => n.hasClass(k)) ?? 'task';

/** One circle per node with a `badge` number, centred on its top-right corner, scaled with the zoom. */
function placeBadges(c: Cy, layer: HTMLDivElement) {
  const have = new Map([...layer.children].map((el) => [(el as HTMLElement).dataset.id!, el as HTMLElement]));
  const zoom = c.zoom();
  c.nodes().forEach((n) => {
    const value = n.data('badge') as number | undefined;
    if (value == null) return;
    let el = have.get(n.id());
    if (el) have.delete(n.id());
    else {
      el = document.createElement('span');
      el.className = 'badge';
      el.dataset.id = n.id();
      layer.append(el);
    }
    if (el.textContent !== String(value)) el.textContent = String(value);
    const bb = n.renderedBoundingBox({ includeLabels: false, includeOverlays: false });
    el.style.transform = `translate(${bb.x2}px, ${bb.y1}px) scale(${zoom}) translate(-50%, -50%)`;
  });
  for (const el of have.values()) el.remove();
}
