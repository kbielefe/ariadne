import cytoscape, { type Core as Cy, type ElementDefinition } from 'cytoscape';
import { ArrowDownUp, Crosshair, Expand, Maximize, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Plus, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type Direction, readiness, reachable } from '../shared/graph';
import { EDGE_RULES, type EdgeKind, EdgeKind as EdgeKinds, type NodeKind } from '../shared/model';
import { remember } from './api';
import { useApp } from './App';
import { KindIcon } from './bits';
import { NewNodeForm, NodePanel } from './NodePanel';
import { NODE_SIZE, placeNew, type Pos, type View, loadView, saveView } from './placement';
import { layered, type LayoutEdge, type LayoutNode } from './layouts';
import { DEFAULT_SORT, isSort, SORTS, type Sort, sortNodes } from './order';

const NODE_KINDS: NodeKind[] = ['task', 'person', 'team', 'resource'];

interface Filters {
  kinds: NodeKind[];
  edges: EdgeKind[];
  showClosed: boolean;
  showImpact: boolean;
  direction: Direction;
  depth: number;
}

const DEFAULT_FILTERS: Filters = { kinds: NODE_KINDS, edges: [...EdgeKinds.options], showClosed: false, showImpact: false, direction: 'down', depth: 0 };

function loadSort(): Sort {
  const s = remember.get('graphSort');
  return isSort(s) ? s : DEFAULT_SORT;
}

function loadFilters(): Filters {
  try {
    const f: Filters = { ...DEFAULT_FILTERS, ...JSON.parse(remember.get('graphFilters') ?? '{}') };
    return { ...f, kinds: f.kinds.filter((k) => NODE_KINDS.includes(k)) };
  } catch {
    return DEFAULT_FILTERS;
  }
}

export function GraphView({ selected, onSelect }: { selected: string | null; onSelect(id: string | null): void }) {
  const { graph, byId, impact, focus, setFocus } = useApp();
  const [f, setF] = useState<Filters>(loadFilters);
  const [creating, setCreating] = useState(false);
  const [sort, setSortState] = useState<Sort>(loadSort);
  const setSort = (x: Sort) => {
    setSortState(x);
    remember.set('graphSort', x);
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

  // What to draw: kind and status filters, then (with a focus) only what's reachable from it.
  const elements = useMemo(() => {
    let ids = new Set(graph.nodes.filter((n) => f.kinds.includes(n.kind) && (f.showClosed || n.status !== 'done' && n.status !== 'dropped')).map((n) => n.id));
    const edges = graph.edges.filter((e) => f.edges.includes(e.kind));
    if (focus && byId.has(focus)) {
      const r = reachable(edges, focus, { direction: f.direction, ...(f.depth ? { depth: f.depth } : {}) });
      ids = new Set([...ids].filter((id) => r.has(id)));
      ids.add(focus);
    }
    const els: ElementDefinition[] = [];
    // Elements carry their place in the sort; the layout lays siblings out in that order.
    const order = new Map(sortNodes([...ids].map((id) => byId.get(id)!), sort, graph.edges, byId).map((n, i) => [n.id, i]));
    for (const id of order.keys()) {
      const n = byId.get(id)!;
      const classes: string[] = [n.kind];
      if (n.kind === 'task') {
        classes.push(n.status ?? 'open');
        if (n.status === 'open') classes.push(readiness(n, graph.edges, byId).ready ? 'ready' : 'waiting');
        if (!graph.edges.some((e) => e.kind === 'needs' && e.dst === id)) classes.push('root');
      }
      if (id === focus) classes.push('focus');
      const label = n.title.length > 64 ? `${n.title.slice(0, 63)}…` : n.title;
      // The canvas draws this as a badge on the node's top-right corner.
      const badge = f.showImpact && n.kind === 'task' ? (impact.get(id) ?? 0) : undefined;
      els.push({ group: 'nodes', data: { id, label, title: n.title, order: order.get(id), badge }, classes: classes.join(' ') });
    }
    for (const e of edges) if (ids.has(e.src) && ids.has(e.dst)) els.push({ group: 'edges', data: { id: e.id, source: e.src, target: e.dst, label: e.kind === 'needs' ? '' : EDGE_RULES[e.kind].label, order: order.get(e.dst) }, classes: e.kind });
    return els;
  }, [graph, byId, impact, f, focus, sort]);

  // Each view remembers its own arrangement.
  const viewKey = [sort, focus ?? '', focus ? `${f.direction}${f.depth}` : ''].join('|');

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
        <fieldset disabled={!focus}>
          <legend>
            <Crosshair size={12} /> From the focus
          </legend>
          <select value={f.direction} onChange={(e) => update({ direction: e.target.value as Direction })} aria-label="Direction">
            <option value="down">what it needs, uses, involves</option>
            <option value="up">what needs it</option>
            <option value="both">both ways</option>
          </select>
          <select value={f.depth} onChange={(e) => update({ depth: Number(e.target.value) })} aria-label="Depth">
            <option value={0}>any depth</option>
            {[1, 2, 3, 4, 5].map((d) => (
              <option key={d} value={d}>
                {d} step{d > 1 ? 's' : ''}
              </option>
            ))}
          </select>
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
          {counts.shown} of {counts.total} shown. Click to select, double-click to focus.
        </p>
      </aside>
      <div className="canvas-wrap">
        <Canvas elements={elements} viewKey={viewKey} arrange={arrangeLayered} selected={selected} onSelect={onSelect} onFocus={setFocus} />
        <div className="canvas-tools">
          <button className="btn icon-btn" aria-label={panes.filters ? 'Hide filters' : 'Show filters'} aria-pressed={panes.filters} title={panes.filters ? 'Hide filters' : 'Show filters'} onClick={() => setPane({ filters: !panes.filters })}>
            {panes.filters ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
          </button>
          <button
            className="btn primary"
            onClick={() => {
              onSelect(null);
              setCreating(true);
              setPane({ details: true });
            }}
          >
            <Plus size={16} /> New
          </button>
          {focus && (
            <button className="btn on" title="Clear the focus and show the whole graph" onClick={() => setFocus(null)}>
              <Expand size={16} /> Show all
            </button>
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
            onClose={() => {
              onSelect(null);
              setPane({ details: false });
            }}
          />
        ) : creating || !graph.nodes.length ? (
          <NewNodeForm
            onCreated={(id) => {
              setCreating(false);
              onSelect(id);
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
    { selector: 'node.task.root', style: { 'font-weight': 'bold', 'border-width': 3 } },
    { selector: 'node.task.done, node.task.dropped', style: { color: muted, opacity: 0.6 } },
    { selector: 'node.task.dropped', style: { 'text-decoration': 'line-through' } as never },
    { selector: 'node.person', style: { shape: 'ellipse', width: NODE_SIZE.person.w, 'background-color': css('--person', '#eef2ff') } },
    { selector: 'node.team', style: { shape: 'octagon', width: NODE_SIZE.team.w, 'background-color': css('--team', '#fef3c7') } },
    { selector: 'node.resource', style: { shape: 'tag', width: NODE_SIZE.resource.w, 'background-color': css('--resource', '#f3f4f6') } },
    { selector: 'node.focus', style: { 'border-color': accent, 'border-width': 4 } },
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
    { selector: 'edge:selected', style: { 'line-color': accent, 'target-arrow-color': accent, width: 3 } },
  ];
}

/** Lays out every node from scratch and returns where they go. */
type Arrange = (c: Cy) => Promise<View>;

/** What a layout needs to know about the drawn graph. */
function layoutInput(c: Cy): { nodes: LayoutNode[]; edges: LayoutEdge[] } {
  return {
    nodes: c.nodes().map((n) => ({ id: n.id(), kind: kindOf(n), order: n.data('order') as number })),
    edges: c.edges().map((e) => ({ src: e.data('source') as string, dst: e.data('target') as string, kind: e.classes()[0] as EdgeKind })),
  };
}

const arrangeLayered: Arrange = (c) => {
  const { nodes, edges } = layoutInput(c);
  return layered(nodes, edges);
};

function fitView(c: Cy) {
  c.fit(undefined, 30);
  // A handful of nodes shouldn't fill the screen.
  if (c.zoom() > 1.1) {
    c.zoom(1.1);
    c.center();
  }
}

function Canvas(p: { elements: ElementDefinition[]; viewKey: string; arrange: Arrange; selected: string | null; onSelect(id: string | null): void; onFocus(id: string): void }) {
  const { elements, viewKey, selected } = p;
  const box = useRef<HTMLDivElement>(null);
  const cy = useRef<Cy | null>(null);
  const handlers = useRef({ onSelect: p.onSelect, onFocus: p.onFocus, arrange: p.arrange });
  handlers.current = { onSelect: p.onSelect, onFocus: p.onFocus, arrange: p.arrange };
  // The arrangement on screen; nodes keep these positions until the view changes or you re-arrange.
  const view = useRef<{ key: string; v: View } | null>(null);
  const runs = useRef(0);
  const [rearranged, setRearranged] = useState(0);
  const handled = useRef(0);
  const badges = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const c = cytoscape({ container: box.current!, style: styles(), wheelSensitivity: 1.5, minZoom: 0.15, maxZoom: 2.5, boxSelectionEnabled: false });
    c.on('tap', 'node', (e) => handlers.current.onSelect(e.target.id()));
    c.on('tap', (e) => {
      if (e.target === c) handlers.current.onSelect(null);
    });
    c.on('dbltap', 'node', (e) => handlers.current.onFocus(e.target.id()));
    // A node you drag stays where you put it.
    c.on('dragfree', 'node', (e) => {
      if (!view.current) return;
      view.current.v.pos.set(e.target.id(), { ...e.target.position() });
      saveView(view.current.key, view.current.v);
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
      ro.disconnect();
      mq.removeEventListener('change', restyle);
      c.destroy();
    };
  }, []);

  // Patch elements in place, then position only what needs it.
  useEffect(() => {
    const c = cy.current!;
    const want = new Map(elements.map((e) => [e.data.id!, e]));
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
    const apply = (pos: ReadonlyMap<string, Pos>) =>
      c.batch(() =>
        c.nodes().forEach((n) => {
          const at = pos.get(n.id());
          if (at) n.position({ ...at });
        }),
      );
    // Nodes this view hasn't placed yet go beside their neighbours.
    const placeRest = (cur: { key: string; v: View }) => {
      const ids = c.nodes().map((n) => n.id());
      const edges = c.edges().map((e) => ({ src: e.data('source') as string, dst: e.data('target') as string }));
      const size = (id: string) => NODE_SIZE[kindOf(c.getElementById(id))];
      const visible = new Map([...cur.v.pos].filter(([id]) => want.has(id)));
      const added = placeNew(ids, edges, visible, size, cur.v.flow);
      for (const [id, at] of added) cur.v.pos.set(id, at);
      apply(cur.v.pos);
      if (added.size) saveView(cur.key, cur.v);
    };

    const forced = rearranged !== handled.current;
    handled.current = rearranged;
    if (!forced && view.current?.key === viewKey) {
      placeRest(view.current);
      return;
    }
    // A new view: use what it remembers if that covers most of it, otherwise lay it out.
    const saved = forced ? null : loadView(viewKey);
    const ids = [...want.values()].filter((e) => e.group === 'nodes');
    if (saved && ids.filter((e) => saved.pos.has(e.data.id!)).length * 2 >= ids.length) {
      view.current = { key: viewKey, v: saved };
      placeRest(view.current);
      fitView(c);
      return;
    }
    const run = ++runs.current;
    void handlers.current.arrange(c).then((v) => {
      if (run !== runs.current) return;
      view.current = { key: viewKey, v };
      apply(v.pos);
      saveView(viewKey, v);
      fitView(c);
    });
  }, [elements, viewKey, rearranged]);

  useEffect(() => {
    const c = cy.current!;
    c.$(':selected').unselect();
    if (selected) c.getElementById(selected).select();
  }, [selected, elements]);

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
