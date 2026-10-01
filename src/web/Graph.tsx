import cytoscape, { type Core as Cy, type ElementDefinition } from 'cytoscape';
import dagre from 'cytoscape-dagre';
import { Crosshair, Maximize, Plus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type Direction, readiness, reachable } from '../shared/graph';
import { EDGE_RULES, type EdgeKind, EdgeKind as EdgeKinds, type NodeKind, USER_ID } from '../shared/model';
import { remember } from './api';
import { useApp } from './App';
import { KindIcon } from './bits';
import { NewNodeForm, NodePanel } from './NodePanel';

cytoscape.use(dagre);

const NODE_KINDS: NodeKind[] = ['task', 'person', 'agent', 'team', 'resource'];

interface Filters {
  kinds: NodeKind[];
  edges: EdgeKind[];
  showClosed: boolean;
  showAssigned: boolean;
  direction: Direction;
  depth: number;
}

const DEFAULT_FILTERS: Filters = { kinds: NODE_KINDS, edges: [...EdgeKinds.options], showClosed: false, showAssigned: true, direction: 'down', depth: 0 };

function loadFilters(): Filters {
  try {
    return { ...DEFAULT_FILTERS, ...JSON.parse(remember.get('graphFilters') ?? '{}') };
  } catch {
    return DEFAULT_FILTERS;
  }
}

export function GraphView({ selected, onSelect }: { selected: string | null; onSelect(id: string | null): void }) {
  const { graph, byId, focus, setFocus } = useApp();
  const [f, setF] = useState<Filters>(loadFilters);
  const [creating, setCreating] = useState(false);
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
      // Who is working on what you're looking at.
      if (f.showAssigned) for (const a of graph.assignments) if (a.recipient !== USER_ID && a.tasks.some((t) => ids.has(t)) && f.kinds.includes(byId.get(a.recipient)?.kind ?? 'task')) ids.add(a.recipient);
    }
    const els: ElementDefinition[] = [];
    for (const id of ids) {
      const n = byId.get(id)!;
      const classes: string[] = [n.kind];
      if (n.kind === 'task') {
        classes.push(n.status ?? 'open');
        if (n.status === 'open') classes.push(readiness(n, graph.edges, byId).ready ? 'ready' : 'waiting');
        if (!graph.edges.some((e) => e.kind === 'needs' && e.dst === id)) classes.push('root');
      }
      if (n.attrs.paused) classes.push('paused');
      if (id === focus) classes.push('focus');
      els.push({ group: 'nodes', data: { id, label: n.title }, classes: classes.join(' ') });
    }
    for (const e of edges) if (ids.has(e.src) && ids.has(e.dst)) els.push({ group: 'edges', data: { id: e.id, source: e.src, target: e.dst, label: e.kind === 'needs' ? '' : EDGE_RULES[e.kind].label }, classes: e.kind });
    if (f.showAssigned)
      for (const a of graph.assignments.filter((x) => x.recipient !== USER_ID)) // your cards live in the timeline
        for (const t of a.tasks)
          if (ids.has(t) && ids.has(a.recipient)) els.push({ group: 'edges', data: { id: `as:${a.eventId}:${t}`, source: t, target: a.recipient, label: 'assigned' }, classes: 'assigned' });
    return els;
  }, [graph, byId, f, focus]);

  const counts = useMemo(() => ({ shown: elements.filter((e) => e.group === 'nodes').length, total: graph.nodes.length }), [elements, graph]);

  return (
    <div className="graph-view">
      <aside className="filters" aria-label="Filters">
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
          <label className="check">
            <input type="checkbox" checked={f.showAssigned} onChange={(e) => update({ showAssigned: e.target.checked })} /> assigned (open work)
          </label>
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
        <p className="muted small">
          {counts.shown} of {counts.total} shown. Click to select, double-click to focus.
        </p>
      </aside>
      <div className="canvas-wrap">
        <Canvas elements={elements} selected={selected} onSelect={onSelect} onFocus={setFocus} />
        <div className="canvas-tools">
          <button
            className="btn primary"
            onClick={() => {
              onSelect(null);
              setCreating(true);
            }}
          >
            <Plus size={16} /> New
          </button>
        </div>
      </div>
      <aside className="panel" aria-label="Details">
        {selected && byId.has(selected) ? (
          <NodePanel id={selected} onSelect={onSelect} />
        ) : creating || !graph.nodes.length ? (
          <NewNodeForm
            onCreated={(id) => {
              setCreating(false);
              onSelect(id);
            }}
          />
        ) : (
          <div className="panel-empty">
            <p>Select something to see and edit it, or</p>
            <button className="btn" onClick={() => setCreating(true)}>
              <Plus size={14} /> Create a node
            </button>
          </div>
        )}
      </aside>
    </div>
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
  const warn = css('--warn', '#b45309');
  return [
    {
      selector: 'node',
      style: {
        label: 'data(label)',
        'text-wrap': 'wrap',
        'text-max-width': '150px',
        'font-size': 12,
        color: fg,
        'text-valign': 'center',
        'text-halign': 'center',
        'background-color': surface,
        'border-width': 1.5,
        'border-color': line,
        width: 170,
        height: 44,
        shape: 'round-rectangle',
      },
    },
    { selector: 'node.task.ready', style: { 'border-color': good, 'border-width': 2.5 } },
    { selector: 'node.task.waiting', style: { 'border-style': 'dashed' } },
    { selector: 'node.task.root', style: { 'font-weight': 'bold', 'border-width': 3 } },
    { selector: 'node.task.done, node.task.dropped', style: { color: muted, opacity: 0.6 } },
    { selector: 'node.task.dropped', style: { 'text-decoration': 'line-through' } as never },
    { selector: 'node.person', style: { shape: 'ellipse', width: 120, 'background-color': css('--person', '#eef2ff') } },
    { selector: 'node.agent', style: { shape: 'hexagon', width: 130, 'background-color': css('--agent', '#ecfdf5') } },
    { selector: 'node.team', style: { shape: 'octagon', width: 130, 'background-color': css('--team', '#fef3c7') } },
    { selector: 'node.resource', style: { shape: 'tag', width: 140, 'background-color': css('--resource', '#f3f4f6') } },
    { selector: 'node.paused', style: { opacity: 0.5 } },
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
    { selector: 'edge.assigned', style: { 'line-color': warn, 'target-arrow-color': warn, 'line-style': 'dashed', color: warn } },
    { selector: 'edge:selected', style: { 'line-color': accent, 'target-arrow-color': accent, width: 3 } },
  ];
}

function Canvas({ elements, selected, onSelect, onFocus }: { elements: ElementDefinition[]; selected: string | null; onSelect(id: string | null): void; onFocus(id: string): void }) {
  const box = useRef<HTMLDivElement>(null);
  const cy = useRef<Cy | null>(null);
  const handlers = useRef({ onSelect, onFocus });
  handlers.current = { onSelect, onFocus };
  const shape = useRef('');

  useEffect(() => {
    const c = cytoscape({ container: box.current!, style: styles(), wheelSensitivity: 0.3, minZoom: 0.15, maxZoom: 2.5, boxSelectionEnabled: false });
    c.on('tap', 'node', (e) => handlers.current.onSelect(e.target.id()));
    c.on('tap', (e) => {
      if (e.target === c) handlers.current.onSelect(null);
    });
    c.on('dbltap', 'node', (e) => handlers.current.onFocus(e.target.id()));
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const restyle = () => c.style(styles());
    mq.addEventListener('change', restyle);
    cy.current = c;
    return () => {
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
    const key = elements.map((e) => e.data.id).sort().join(',');
    if (key !== shape.current) {
      shape.current = key;
      const layout = c.layout({ name: 'dagre', rankDir: 'TB', nodeSep: 30, rankSep: 70, animate: false, fit: true, padding: 30 } as cytoscape.LayoutOptions);
      // A handful of nodes shouldn't fill the screen.
      layout.one('layoutstop', () => {
        if (c.zoom() > 1.1) {
          c.zoom(1.1);
          c.center();
        }
      });
      layout.run();
    }
  }, [elements]);

  useEffect(() => {
    const c = cy.current!;
    c.$(':selected').unselect();
    if (selected) c.getElementById(selected).select();
  }, [selected, elements]);

  return (
    <>
      <div ref={box} className="canvas" role="img" aria-label="Graph of tasks, people, agents, teams, and resources" />
      <button className="icon fit" aria-label="Fit to screen" onClick={() => cy.current?.animate({ fit: { eles: cy.current.elements(), padding: 30 } }, { duration: 200 })}>
        <Maximize size={16} />
      </button>
    </>
  );
}
