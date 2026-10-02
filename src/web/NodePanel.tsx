import { Crosshair, Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ACTOR_KINDS, ANALYST_ID, EDGE_RULES, type Edge, type EdgeKind, Effort, type Event, type Node, type NodeKind, type Op, ResourceType, USER_ID } from '../shared/model';
import { api, type NodeDetail } from './api';
import { useApp } from './App';
import { ago, KindIcon, Md, NodeChip } from './bits';
import { DeleteNode } from './DeleteNode';
import { NodePicker } from './NodePicker';

/** Runs ops and returns an error message, or null. */
function useOps() {
  const [error, setError] = useState<string | null>(null);
  const run = async (ops: Op[]) => {
    setError(null);
    try {
      return await api.ops(ops);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  };
  return { error, run, clear: () => setError(null) };
}

// ================================================================ create

const KINDS: NodeKind[] = ['task', 'person', 'agent', 'team', 'resource'];

export function NewNodeForm({ onCreated }: { onCreated(id: string): void }) {
  const { focus, byId } = useApp();
  const [kind, setKind] = useState<NodeKind>('task');
  const [title, setTitle] = useState('');
  const [underFocus, setUnderFocus] = useState(true);
  const { error, run } = useOps();
  const focusNode = focus ? byId.get(focus) : undefined;
  const link = kind === 'task' && focusNode?.kind === 'task' && underFocus;
  return (
    <form
      className="panel-body"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!title.trim()) return;
        const r = await run([{ op: 'create_node', ref: 'n', kind, title: title.trim() }, ...(link ? [{ op: 'create_edge' as const, src: focus!, kind: 'needs' as const, dst: '$n' }] : [])]);
        if (r) {
          setTitle('');
          onCreated(r.results[0]!.id);
        }
      }}
    >
      <h2>New</h2>
      <div className="seg" role="radiogroup" aria-label="Kind">
        {KINDS.map((k) => (
          <button type="button" key={k} role="radio" aria-checked={kind === k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
            <KindIcon kind={k} /> {k}
          </button>
        ))}
      </div>
      <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder={kind === 'task' ? 'What needs doing?' : 'Name'} aria-label="Title" />
      {kind === 'task' && focusNode?.kind === 'task' && (
        <label className="check">
          <input type="checkbox" checked={underFocus} onChange={(e) => setUnderFocus(e.target.checked)} /> needed by “{focusNode.title}”
        </label>
      )}
      <button className="btn primary" disabled={!title.trim()}>
        <Plus size={14} /> Create
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

// ================================================================ view / edit

export function NodePanel({ id, onSelect, onClose }: { id: string; onSelect(id: string | null): void; onClose(): void }) {
  const { version, setFocus, focus } = useApp();
  const [d, setD] = useState<NodeDetail | null>(null);
  const { error, run } = useOps();
  useEffect(() => {
    let live = true;
    api.node(id).then((x) => live && setD(x), () => {});
    return () => {
      live = false;
    };
  }, [id, version]);
  if (!d || d.node.id !== id) return <div className="panel-body muted">Loading…</div>;
  const n = d.node;
  const save = (p: Omit<Extract<Op, { op: 'update_node' }>, 'op' | 'id'>) => run([{ op: 'update_node', id, version: n.version, ...p }]);
  const protectedNode = id === USER_ID || id === ANALYST_ID;
  return (
    <div className="panel-body" key={id}>
      <div className="panel-head">
        <KindIcon kind={n.kind} size={18} />
        <InlineText value={n.title} onSave={(title) => save({ title })} className="title-input" label="Title" />
        <button className="icon" aria-label="Close" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <div className="row">
        {n.kind === 'task' && (
          <select value={n.status ?? 'open'} onChange={(e) => save({ status: e.target.value as 'open' })} aria-label="Status">
            <option value="open">open</option>
            <option value="done">done</option>
            <option value="dropped">dropped</option>
          </select>
        )}
        {d.readiness && <span className={`tag ${d.readiness.ready ? 'good' : ''}`}>{n.status !== 'open' ? n.status : d.readiness.ready ? 'ready' : `waiting on ${d.readiness.waitingOn.length}`}</span>}
        <button className={`btn small ${focus === id ? 'on' : ''}`} onClick={() => setFocus(focus === id ? null : id)}>
          <Crosshair size={14} /> {focus === id ? 'Focused' : 'Focus'}
        </button>
        {!protectedNode && <DeleteNode detail={d} run={run} onDeleted={() => onSelect(null)} />}
      </div>
      {error && <p className="error">{error}</p>}

      <Section title="Description">
        <InlineText value={n.body} multiline onSave={(body) => save({ body })} label="Description" placeholder="Markdown. What it is, why it matters, what done looks like." />
      </Section>

      <Attrs node={n} save={save} />
      <Edges detail={d} run={run} onSelect={onSelect} />
      <Events node={n} events={d.events} run={run} />
      <p className="muted small">
        Updated {ago(n.updatedAt)} · v{n.version} · <code>{n.id}</code>
      </p>
    </div>
  );
}

function Section({ title, children, open = true }: { title: string; children: React.ReactNode; open?: boolean }) {
  return (
    <details className="section" open={open}>
      <summary>{title}</summary>
      {children}
    </details>
  );
}

/** Text that saves on blur (or Enter for one line). */
function InlineText(p: { value: string; onSave(v: string): unknown; multiline?: boolean; className?: string; label: string; placeholder?: string }) {
  const [v, setV] = useState(p.value);
  useEffect(() => setV(p.value), [p.value]);
  const commit = () => {
    if (v !== p.value && (v.trim() || p.multiline)) void p.onSave(v);
  };
  if (p.multiline)
    return <textarea className={p.className} aria-label={p.label} placeholder={p.placeholder} rows={Math.min(12, Math.max(3, v.split('\n').length + 1))} value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} />;
  return (
    <input
      className={p.className}
      aria-label={p.label}
      placeholder={p.placeholder}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setV(p.value);
      }}
    />
  );
}

const list = (v: unknown) => (Array.isArray(v) ? v.join(', ') : '');
const parseList = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

const BRIEFS = [
  ['onAssignment', 'When it receives an assignment'],
  ['onReport', 'When it reports back'],
  ['onDelegate', 'When it assigns to a subordinate'],
  ['onReview', 'When it receives results'],
] as const;

function Attrs({ node: n, save }: { node: Node; save(p: { attrs: Record<string, unknown> }): unknown }) {
  const a = n.attrs;
  const set = (k: string, v: unknown) => save({ attrs: { [k]: v === '' || (Array.isArray(v) && !v.length) ? null : v } });
  const briefs = (a.briefs ?? {}) as Record<string, string>;
  return (
    <>
      {n.kind === 'task' && (
        <Section title="Guidance (inherited by everything it needs)">
          <InlineText value={String(a.guidance ?? '')} multiline onSave={(v) => set('guidance', v)} label="Guidance" placeholder="e.g. Small PRs. Ask before touching the auth module." />
        </Section>
      )}
      {n.kind === 'resource' && (
        <Section title="Resource">
          <div className="row">
            <select value={String(a.type ?? '')} onChange={(e) => set('type', e.target.value)} aria-label="Type">
              <option value="">type…</option>
              {ResourceType.options.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
            <InlineText value={String(a.url ?? '')} onSave={(v) => set('url', v)} label="URL" placeholder="https://…" />
          </div>
          {typeof a.url === 'string' && a.url && (
            <a href={a.url} target="_blank" rel="noreferrer" className="small">
              Open {a.url}
            </a>
          )}
        </Section>
      )}
      {(ACTOR_KINDS as readonly string[]).includes(n.kind) && (
        <>
          <Section title="Areas (owns / can help with)">
            <InlineText value={list(a.areas)} onSave={(v) => set('areas', parseList(v))} label="Areas" placeholder="comma separated, e.g. RBAC, feature flags" />
          </Section>
          {n.kind === 'agent' && (
            <Section title="Agent">
              <label className="field">
                <span>Models, cheapest first</span>
                <InlineText value={list(a.models)} onSave={(v) => set('models', parseList(v))} label="Models" placeholder="haiku, sonnet, opus" />
              </label>
              <div className="row">
                <label className="field">
                  <span>Default effort</span>
                  <select value={String(a.effort ?? '')} onChange={(e) => set('effort', e.target.value)}>
                    <option value="">—</option>
                    {Effort.options.map((x) => (
                      <option key={x}>{x}</option>
                    ))}
                  </select>
                </label>
                <label className="check">
                  <input type="checkbox" checked={!!a.paused} onChange={(e) => set('paused', e.target.checked || null)} /> paused
                </label>
                <label className="check" title="Answers System One questions (choice / score / yes-no); writes no text">
                  <input type="checkbox" checked={!!a.decider} onChange={(e) => set('decider', e.target.checked || null)} /> System One decider
                </label>
                <label className="check" title="Works in an interactive Claude Code session: its events wait until a session claims them over MCP (claim_assignment)">
                  <input type="checkbox" checked={!!a.interactive} onChange={(e) => set('interactive', e.target.checked || null)} /> interactive (Claude Code)
                </label>
              </div>
            </Section>
          )}
          <Section title="Briefs" open={Object.keys(briefs).length > 0}>
            {BRIEFS.map(([k, label]) => (
              <label key={k} className="field">
                <span>{label}</span>
                <InlineText value={briefs[k] ?? ''} multiline onSave={(v) => set('briefs', { ...briefs, [k]: v || undefined })} label={label} />
              </label>
            ))}
          </Section>
        </>
      )}
      <Section title="Raw attrs (JSON)" open={false}>
        <RawAttrs node={n} save={save} />
      </Section>
    </>
  );
}

function RawAttrs({ node, save }: { node: Node; save(p: { attrs: Record<string, unknown> }): unknown }) {
  const [text, setText] = useState(JSON.stringify(node.attrs, null, 2));
  const [bad, setBad] = useState(false);
  useEffect(() => setText(JSON.stringify(node.attrs, null, 2)), [node.attrs]);
  return (
    <>
      <textarea className="mono" rows={6} value={text} onChange={(e) => setText(e.target.value)} aria-label="Raw attrs" />
      <button
        className="btn small"
        onClick={() => {
          try {
            const next = JSON.parse(text) as Record<string, unknown>;
            setBad(false);
            // Keys you removed become null so the merge deletes them.
            const removed = Object.fromEntries(Object.keys(node.attrs).filter((k) => !(k in next)).map((k) => [k, null]));
            void save({ attrs: { ...removed, ...next } });
          } catch {
            setBad(true);
          }
        }}
      >
        Save attrs
      </button>
      {bad && <span className="error">Not valid JSON</span>}
    </>
  );
}

// ---------------------------------------------------------------- edges

function Edges({ detail: d, run, onSelect }: { detail: NodeDetail; run(ops: Op[]): Promise<unknown>; onSelect(id: string): void }) {
  const { byId } = useApp();
  const n = d.node;
  const out = d.edges.filter((e) => e.src === n.id);
  const inc = d.edges.filter((e) => e.dst === n.id);
  const label = (e: Edge, outgoing: boolean) => (outgoing ? EDGE_RULES[e.kind].label : e.kind === 'needs' ? 'needed by' : e.kind === 'reports_to' ? 'supervises' : `${EDGE_RULES[e.kind].label} (from)`);
  const row = (e: Edge, outgoing: boolean) => {
    const other = outgoing ? e.dst : e.src;
    return (
      <li key={e.id}>
        <span className="muted small edge-label">{label(e, outgoing)}</span>
        <button className="link" onClick={() => onSelect(other)}>
          <KindIcon kind={byId.get(other)?.kind ?? 'task'} /> {byId.get(other)?.title ?? '(deleted)'}
          {byId.get(other)?.status && byId.get(other)!.status !== 'open' && <span className="muted"> ({byId.get(other)!.status})</span>}
        </button>
        {e.note && <span className="muted small"> — {e.note}</span>}
        <button className="icon" aria-label="Remove edge" onClick={() => void run([{ op: 'delete_edge', id: e.id }])}>
          <X size={14} />
        </button>
      </li>
    );
  };
  return (
    <Section title={`Connections (${d.edges.length})`}>
      <ul className="edges">
        {out.map((e) => row(e, true))}
        {inc.map((e) => row(e, false))}
      </ul>
      {n.kind === 'task' && <QuickSubtask parent={n.id} run={run} />}
      <AddEdge node={n} run={run} />
    </Section>
  );
}

function QuickSubtask({ parent, run }: { parent: string; run(ops: Op[]): Promise<unknown> }) {
  const [t, setT] = useState('');
  return (
    <form
      className="row"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!t.trim()) return;
        if (await run([{ op: 'create_node', ref: 'n', kind: 'task', title: t.trim() }, { op: 'create_edge', src: parent, kind: 'needs', dst: '$n' }])) setT('');
      }}
    >
      <input value={t} onChange={(e) => setT(e.target.value)} placeholder="New task this needs…" aria-label="New needed task" />
      <button className="btn small" disabled={!t.trim()}>
        <Plus size={14} /> Add
      </button>
    </form>
  );
}

/** Add an edge from (or to) this node. Only kinds that fit this node are offered. */
function AddEdge({ node: n, run }: { node: Node; run(ops: Op[]): Promise<unknown> }) {
  const options = (Object.entries(EDGE_RULES) as [EdgeKind, (typeof EDGE_RULES)[EdgeKind]][]).flatMap(([k, r]) => [
    ...(r.src.includes(n.kind) ? [{ key: `out:${k}`, kind: k, outgoing: true, label: r.label, targets: r.dst }] : []),
    ...(r.dst.includes(n.kind) && k !== 'member_of' ? [{ key: `in:${k}`, kind: k, outgoing: false, label: k === 'needs' ? 'needed by' : k === 'reports_to' ? 'supervises' : `${r.label} (from)`, targets: r.src }] : []),
  ]);
  const [choice, setChoice] = useState(options[0]?.key ?? '');
  const o = options.find((x) => x.key === choice) ?? options[0];
  if (!o) return null;
  return (
    <div className="add-edge">
      <select value={o.key} onChange={(e) => setChoice(e.target.value)} aria-label="Edge kind">
        {options.map((x) => (
          <option key={x.key} value={x.key}>
            {x.label}
          </option>
        ))}
      </select>
      <NodePicker
        placeholder="…which node?"
        kinds={[...o.targets]}
        exclude={[n.id]}
        onPick={(t) => void run([{ op: 'create_edge', kind: o.kind, src: o.outgoing ? n.id : t.id, dst: o.outgoing ? t.id : n.id }])}
      />
    </div>
  );
}

// ---------------------------------------------------------------- events

function Events({ node: n, events, run }: { node: Node; events: Event[]; run(ops: Op[]): Promise<unknown> }) {
  const { name } = useApp();
  const [editing, setEditing] = useState<string | null>(null);
  if (!events.length) return null;
  return (
    <Section title={`Events (${events.length})`} open={events.length < 6}>
      <ul className="events">
        {[...events].reverse().map((e) => (
          <li key={e.id} className={`ev ev-${e.kind}`}>
            <div className="ev-head">
              <span className="tag">{e.card ? 'card' : e.kind}</span>
              <span>
                {name(e.sender)} → {name(e.recipient)}
              </span>
              {e.state && <span className={`tag ${e.state}`}>{e.state}</span>}
              <span className="muted small">{ago(e.createdAt)}</span>
            </div>
            {editing === e.id ? (
              <EventEditor ev={e} run={run} done={() => setEditing(null)} />
            ) : (
              <>
                {e.card && <strong>{e.card.title}</strong>}
                <Md text={e.body.length > 400 ? `${e.body.slice(0, 400)}…` : e.body} />
                {Object.entries(e.decisions).length > 0 && (
                  <p className="muted small">
                    {Object.entries(e.decisions)
                      .map(([k, d]) => `${k}: ${String(d.value)} (${d.by}${d.confidence != null ? ` ${Math.round(d.confidence * 100)}%` : ''})`)
                      .join(' · ')}
                  </p>
                )}
                <div className="chips">
                  {e.tasks
                    .filter((t) => t !== n.id)
                    .map((t) => (
                      <NodeChip key={t} id={t} />
                    ))}
                </div>
                <div className="row">
                  <button className="link small" onClick={() => setEditing(e.id)}>
                    Edit
                  </button>
                  {n.kind === 'task' && (
                    <button className="link small" onClick={() => void run([{ op: 'update_event', id: e.id, tasks: e.tasks.filter((t) => t !== n.id) }])}>
                      Unlink from this task
                    </button>
                  )}
                  <button
                    className="link small danger"
                    onClick={() => {
                      if (confirm('Delete this event?')) void run([{ op: 'delete_event', id: e.id }]);
                    }}
                  >
                    Delete
                  </button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function EventEditor({ ev, run, done }: { ev: Event; run(ops: Op[]): Promise<unknown>; done(): void }) {
  const [body, setBody] = useState(ev.body);
  const [instructions, setInstructions] = useState(ev.instructions);
  const [state, setState] = useState(ev.state);
  const [tasks, setTasks] = useState(ev.tasks);
  return (
    <form
      className="ev-edit"
      onSubmit={async (e) => {
        e.preventDefault();
        if (await run([{ op: 'update_event', id: ev.id, body, instructions, tasks, ...(state ? { state } : {}) }])) done();
      }}
    >
      <textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Body" />
      {ev.kind === 'assign' && <textarea rows={2} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Instructions" aria-label="Instructions" />}
      {ev.kind === 'assign' && (
        <select value={state ?? 'open'} onChange={(e) => setState(e.target.value as Event['state'])} aria-label="State">
          <option>open</option>
          <option>closed</option>
          <option>withdrawn</option>
        </select>
      )}
      <div className="chips">
        {tasks.map((t) => (
          <span key={t} className="chip">
            <NodeChip id={t} />
            <button type="button" className="icon" aria-label="Unlink" onClick={() => setTasks(tasks.filter((x) => x !== t))}>
              <X size={12} />
            </button>
          </span>
        ))}
      </div>
      <NodePicker placeholder="Link a task…" kinds={['task']} exclude={tasks} onPick={(t) => setTasks([...tasks, t.id])} />
      <div className="row">
        <button className="btn small primary">Save</button>
        <button type="button" className="btn small" onClick={done}>
          Cancel
        </button>
      </div>
    </form>
  );
}
