import { Check, CircleSlash, Handshake } from 'lucide-react';
import { useState } from 'react';
import type { Event } from '../shared/model';
import { api } from './api';
import { useApp } from './App';
import { Md, NodeChip } from './bits';

/** A card: an assignment to you. Open cards show in full; answered ones shrink to a line. */
export function CardView({ ev, response }: { ev: Event; response?: Event }) {
  const { name } = useApp();
  const card = ev.card!;
  const from = ev.sender ? name(ev.sender) : 'Ariadne';
  if (ev.state !== 'open') {
    const label = response?.response ? (card.actions.find((a) => a.id === response.response!.action)?.label ?? response.response.action) : ev.state;
    return (
      <div className={`card-line state-${ev.state}`}>
        {ev.state === 'withdrawn' ? <CircleSlash size={14} /> : <Check size={14} />}
        <span className="card-line-title">{card.title}</span>
        <span className="muted">— {label}</span>
        {response && response.body.includes('\n') && (
          <details>
            <summary className="muted">details</summary>
            <Md text={response.body} />
          </details>
        )}
      </div>
    );
  }
  return <OpenCard ev={ev} from={from} />;
}

function OpenCard({ ev, from }: { ev: Event; from: string }) {
  const card = ev.card!;
  const { name } = useApp();
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(card.fields.map((f) => [f.name, f.value ?? (f.type === 'checkbox' ? false : f.type === 'tasks' ? [] : '')])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string, v: unknown) => setValues((x) => ({ ...x, [k]: v }));
  const act = async (action: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.respond(ev.id, action, values);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <section className={`card card-${card.kind}`} aria-label={card.title} data-open-card>
      <header>
        {card.kind === 'proxy' && <Handshake size={16} aria-hidden />}
        <h3>{card.title}</h3>
        <span className="muted small">from {from}</span>
      </header>
      {card.kind === 'proxy' && <p className="muted small">They have no channel to Ariadne, so you carry this conversation and record the answer.</p>}
      <Md text={ev.body} />
      {ev.instructions && <Md text={ev.instructions} />}
      {ev.tasks.length > 0 && (
        <div className="chips">
          {ev.tasks.map((t) => (
            <NodeChip key={t} id={t} />
          ))}
        </div>
      )}
      {card.fields.map((f) => (
        <label key={f.name} className={`field field-${f.type}`}>
          {f.type !== 'checkbox' && <span>{f.label}</span>}
          {f.type === 'text' && <input value={String(values[f.name] ?? '')} onChange={(e) => set(f.name, e.target.value)} />}
          {f.type === 'textarea' && <textarea rows={3} value={String(values[f.name] ?? '')} onChange={(e) => set(f.name, e.target.value)} />}
          {f.type === 'select' && (
            <select value={String(values[f.name] ?? '')} onChange={(e) => set(f.name, e.target.value)}>
              <option value="">Choose…</option>
              {(f.options ?? []).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
          {f.type === 'checkbox' && (
            <span className="check">
              <input type="checkbox" checked={!!values[f.name]} onChange={(e) => set(f.name, e.target.checked)} /> {f.label}
            </span>
          )}
          {f.type === 'tasks' && (
            <ul className="task-checks">
              {(f.options?.map((o) => ({ id: o.value, label: o.label })) ?? ev.tasks.map((id) => ({ id, label: name(id) }))).map((t) => {
                const list = (values[f.name] as string[]) ?? [];
                return (
                  <li key={t.id}>
                    <label className="check">
                      <input type="checkbox" checked={list.includes(t.id)} onChange={(e) => set(f.name, e.target.checked ? [...list, t.id] : list.filter((x) => x !== t.id))} /> {t.label}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </label>
      ))}
      <div className="actions">
        {card.actions.map((a) => (
          <button key={a.id} className={`btn ${a.style}`} disabled={busy} onClick={() => act(a.id)}>
            {a.label}
          </button>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
