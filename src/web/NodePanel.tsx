import { Check, Copy, Crosshair, Pencil, Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ACTOR_KINDS, EDGE_RULES, type Edge, type EdgeKind, type Node, type NodeKind, type Op, ResourceType, USER_ID } from '../shared/model';
import { api, type NodeDetail } from './api';
import { useApp } from './App';
import { ago, KindIcon, Md } from './bits';
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

const KINDS: NodeKind[] = ['task', 'person', 'team', 'resource'];

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
  return (
    <div className="panel-body" key={id}>
      <div className="panel-head">
        <KindIcon kind={n.kind} size={18} />
        <InlineText value={n.title} onSave={(title) => save({ title })} className="title-input" label="Title" />
        <CopyId id={id} />
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
        {id !== USER_ID && <DeleteNode detail={d} run={run} onDeleted={() => onSelect(null)} />}
      </div>
      {error && <p className="error">{error}</p>}

      <Section title="Description">
        <InlineText value={n.body} multiline onSave={(body) => save({ body })} label="Description" placeholder="Markdown. What it is, why it matters, what done looks like." />
      </Section>

      <Attrs node={n} save={save} />
      <Edges detail={d} run={run} onSelect={onSelect} />
      <p className="muted small">
        Updated {ago(n.updatedAt)} · v{n.version} · <code>{n.id}</code>
      </p>
    </div>
  );
}

/** Copies the node id (for MCP calls or notes), with a brief "copied" check. */
function CopyId({ id }: { id: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const t = setTimeout(() => setState('idle'), 1500);
    return () => clearTimeout(t);
  }, [state]);
  const label = state === 'copied' ? 'Copied id' : state === 'failed' ? `Couldn't copy; the id is ${id}` : 'Copy id';
  return (
    <button
      className={`icon copy-id ${state}`}
      aria-label={label}
      title={label}
      onClick={() =>
        (navigator.clipboard?.writeText(id) ?? Promise.reject(new Error('no clipboard'))).then(
          () => setState('copied'),
          () => setState('failed'),
        )
      }
    >
      {state === 'copied' ? <Check size={15} /> : <Copy size={15} />}
      {state === 'copied' && <span className="small">copied</span>}
    </button>
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

/**
 * A field shown read-only (multiline text as markdown) with a pencil that switches it to editing.
 * A failed save (e.g. a version conflict) keeps the editor open, so nothing typed is lost.
 * Enter saves a one-line field, Ctrl/Cmd+Enter a multiline one; Escape cancels.
 */
function InlineText(p: { value: string; onSave(v: string): unknown; multiline?: boolean; className?: string; label: string; placeholder?: string }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(p.value);
  const [saving, setSaving] = useState(false);
  const start = () => {
    setV(p.value);
    setEditing(true);
  };
  const cancel = () => setEditing(false);
  const commit = async () => {
    if (v === p.value) return cancel();
    if (!v.trim() && !p.multiline) return; // one-line fields (titles) can't be blanked
    setSaving(true);
    const r = await p.onSave(v);
    setSaving(false);
    if (r !== null) setEditing(false); // useOps returns null on error and shows the message
  };
  if (!editing)
    return (
      <div className={`field-view ${p.multiline ? 'multi' : ''} ${p.className ?? ''}`}>
        <div className="field-value">{p.value ? p.multiline ? <Md text={p.value} /> : p.value : <span className="muted small">{p.placeholder ?? '—'}</span>}</div>
        <button type="button" className="icon" aria-label={`Edit ${p.label}`} title={`Edit ${p.label}`} onClick={start}>
          <Pencil size={13} />
        </button>
      </div>
    );
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') cancel();
    if (e.key === 'Enter' && (!p.multiline || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void commit();
    }
  };
  return (
    <div className="field-edit">
      {p.multiline ? (
        <textarea autoFocus aria-label={p.label} placeholder={p.placeholder} rows={Math.min(16, Math.max(4, v.split('\n').length + 1))} value={v} onChange={(e) => setV(e.target.value)} onKeyDown={keys} />
      ) : (
        <input autoFocus className={p.className} aria-label={p.label} placeholder={p.placeholder} value={v} onChange={(e) => setV(e.target.value)} onKeyDown={keys} />
      )}
      <div className="row">
        <button type="button" className="btn small primary" disabled={saving} onClick={() => void commit()}>
          <Check size={14} /> Save
        </button>
        <button type="button" className="btn small" onClick={cancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

const list = (v: unknown) => (Array.isArray(v) ? v.join(', ') : '');
const parseList = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

function Attrs({ node: n, save }: { node: Node; save(p: { attrs: Record<string, unknown> }): unknown }) {
  const a = n.attrs;
  const set = (k: string, v: unknown) => save({ attrs: { [k]: v === '' || (Array.isArray(v) && !v.length) ? null : v } });
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
          {a.type === 'branch' && (
            <div className="row" title="Tasks that use this branch ship together in one PR">
              <InlineText value={String(a.repo ?? '')} onSave={(v) => set('repo', v)} label="Repo" placeholder="repo" />
              <InlineText value={String(a.branch ?? '')} onSave={(v) => set('branch', v)} label="Branch" placeholder="branch name" />
            </div>
          )}
          {typeof a.url === 'string' && a.url && (
            <a href={a.url} target="_blank" rel="noreferrer" className="small">
              Open {a.url}
            </a>
          )}
        </Section>
      )}
      {(ACTOR_KINDS as readonly string[]).includes(n.kind) && (
        <Section title="Areas (owns / can help with)">
          <InlineText value={list(a.areas)} onSave={(v) => set('areas', parseList(v))} label="Areas" placeholder="comma separated, e.g. RBAC, feature flags" />
        </Section>
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
