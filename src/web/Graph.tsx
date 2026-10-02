import cytoscape, { type Core as Cy, type ElementDefinition } from 'cytoscape';
import dagre from 'cytoscape-dagre';
import { ArrowDownUp, Crosshair, Expand, Maximize, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Plus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type Direction, readiness, reachable } from '../shared/graph';
import { EDGE_RULES, type EdgeKind, EdgeKind as EdgeKinds, type NodeKind } from '../shared/model';
import { remember } from './api';
import { useApp } from './App';
import { KindIcon } from './bits';
import { NewNodeForm, NodePanel } from './NodePanel';
import { DEFAULT_SORT, isSort, layoutOptions, orderLeafSiblings, rankDir, SORTS, type Sort, sortNodes } from './order';

cytoscape.use(dagre);

const NODE_KINDS: NodeKind[] = ['task', 'person', 'team', 'resource'];

interface Filters {
  kinds: NodeKind[];
  edges: EdgeKind[];
  showClosed: boolean;
  direction: Direction;
  depth: number;
}

const DEFAULT_FILTERS: Filters = { kinds: NODE_KINDS, edges: [...EdgeKinds.options], showClosed: false, direction: 'down', depth: 0 };

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
  const { graph, byId, focus, setFocus } = useApp();
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
      els.push({ group: 'nodes', data: { id, label: n.title.length > 64 ? `${n.title.slice(0, 63)}…` : n.title, title: n.title, order: order.get(id) }, classes: classes.join(' ') });
    }
    for (const e of edges) if (ids.has(e.src) && ids.has(e.dst)) els.push({ group: 'edges', data: { id: e.id, source: e.src, target: e.dst, label: e.kind === 'needs' ? '' : EDGE_RULES[e.kind].label, order: order.get(e.dst) }, classes: e.kind });
    return els;
  }, [graph, byId, f, focus, sort]);

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
        <Canvas elements={elements} sort={sort} selected={selected} onSelect={onSelect} onFocus={setFocus} />
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
        width: 180,
        height: 52,
        shape: 'round-rectangle',
      },
    },
    { selector: 'node.task.ready', style: { 'border-color': good, 'border-width': 2.5 } },
    { selector: 'node.task.waiting', style: { 'border-style': 'dashed' } },
    { selector: 'node.task.root', style: { 'font-weight': 'bold', 'border-width': 3 } },
    { selector: 'node.task.done, node.task.dropped', style: { color: muted, opacity: 0.6 } },
    { selector: 'node.task.dropped', style: { 'text-decoration': 'line-through' } as never },
    { selector: 'node.person', style: { shape: 'ellipse', width: 120, 'background-color': css('--person', '#eef2ff') } },
    { selector: 'node.team', style: { shape: 'octagon', width: 130, 'background-color': css('--team', '#fef3c7') } },
    { selector: 'node.resource', style: { shape: 'tag', width: 140, 'background-color': css('--resource', '#f3f4f6') } },
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

function Canvas({ elements, sort, selected, onSelect, onFocus }: { elements: ElementDefinition[]; sort: Sort; selected: string | null; onSelect(id: string | null): void; onFocus(id: string): void }) {
  const box = useRef<HTMLDivElement>(null);
  const cy = useRef<Cy | null>(null);
  const handlers = useRef({ onSelect, onFocus });
  handlers.current = { onSelect, onFocus };
  const shape = useRef('');

  useEffect(() => {
    const c = cytoscape({ container: box.current!, style: styles(), wheelSensitivity: 1.5, minZoom: 0.15, maxZoom: 2.5, boxSelectionEnabled: false });
    c.on('tap', 'node', (e) => handlers.current.onSelect(e.target.id()));
    c.on('tap', (e) => {
      if (e.target === c) handlers.current.onSelect(null);
    });
    c.on('dbltap', 'node', (e) => handlers.current.onFocus(e.target.id()));
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

  // Patch elements in place; lay out again only when the set of nodes or edges changes.
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
    // Changing the sort lays out again; edits that only move a node in the sort don't.
    const key = `${sort}|${elements.map((e) => e.data.id).sort().join(',')}`;
    if (key !== shape.current) {
      shape.current = key;
      const n = c.nodes().length;
      const layout = c.layout(layoutOptions(n));
      layout.one('layoutstop', () => {
        orderLeafSiblings(c.nodes(), rankDir(n));
        // A handful of nodes shouldn't fill the screen.
        if (c.zoom() > 1.1) {
          c.zoom(1.1);
          c.center();
        }
      });
      layout.run();
    }
  }, [elements, sort]);

  useEffect(() => {
    const c = cy.current!;
    c.$(':selected').unselect();
    if (selected) c.getElementById(selected).select();
  }, [selected, elements]);

  return (
    <>
      <div ref={box} className="canvas" role="img" aria-label="Graph of tasks, people, teams, and resources" />
      <button className="icon fit" aria-label="Fit to screen" onClick={() => cy.current?.animate({ fit: { eles: cy.current.elements(), padding: 30 } }, { duration: 200 })}>
        <Maximize size={16} />
      </button>
    </>
  );
}
