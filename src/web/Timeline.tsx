import { ArrowRight, Bell, Eye, EyeOff, Send, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ANALYST_ID, type Event, USER_ID } from '../shared/model';
import { api, type StatusLine, type Timeline } from './api';
import { useApp } from './App';
import { ago, Md, NodeChip, nodeLink, pct } from './bits';
import { CardView } from './CardView';

/**
 * The augmented chat: what you're focused on, newest at the bottom. Open cards in full, everything
 * answered shrinks. With a focus, only events about that task or what it needs.
 */
export function TimelineView({ statuses }: { statuses: StatusLine[] }) {
  const { focus, version, name } = useApp();
  const [all, setAll] = useState(false);
  const [data, setData] = useState<Timeline>({ events: [], changes: {}, statuses: [] });
  const bottom = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.timeline(focus, all).then(setData, () => {});
  }, [focus, all, version]);

  const { items, responses, openCards } = useMemo(() => {
    const responses = new Map<string, Event>();
    for (const e of data.events) if (e.kind === 'report' && e.sender === USER_ID && e.replyTo && e.response) responses.set(e.replyTo, e);
    const items = data.events.filter((e) => !(e.sender === USER_ID && e.kind === 'report' && e.response));
    const openCards = items.filter((e) => e.card && e.state === 'open');
    return { items, responses, openCards };
  }, [data]);

  // Stay pinned to the bottom when new things arrive, unless you scrolled up to read.
  const last = items.at(-1)?.id;
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 200 || items.length < 3) bottom.current?.scrollIntoView({ block: 'end' });
  }, [last, statuses.length, items.length]);

  const working = statuses.filter((s) => s.text);
  return (
    <div className="timeline">
      <div className="timeline-bar">
        {openCards.length > 0 ? (
          <button className="needs-you" onClick={() => document.querySelector('[data-open-card]')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>
            <Bell size={14} /> {openCards.length} need{openCards.length === 1 ? 's' : ''} you
          </button>
        ) : (
          <span className="muted small">Nothing needs you right now.</span>
        )}
        <button className="ghost small" onClick={() => setAll((a) => !a)} title="Also show assignments and reports between the Analyst and other agents">
          {all ? <EyeOff size={14} /> : <Eye size={14} />} {all ? 'Only mine' : 'Show delegation'}
        </button>
      </div>
      <div className="timeline-list" ref={list}>
        {items.length === 0 && <Empty />}
        {items.map((e) => (
          <Item key={e.id} ev={e} response={responses.get(e.id)} changes={data.changes[e.id]} />
        ))}
        {working.map((s) => (
          <div key={s.actor} className="status-line">
            <span className="pulse" /> {name(s.actor)}: {s.text}
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <Composer />
    </div>
  );
}

function Empty() {
  return (
    <div className="empty">
      <h2>Tell the Analyst what you're working on.</h2>
      <p className="muted">It keeps the graph up to date, hands work to agents, and brings you only what needs you.</p>
    </div>
  );
}

function Item({ ev, response, changes }: { ev: Event; response?: Event; changes?: Timeline['changes'][string] }) {
  const { name } = useApp();
  if (ev.card) return <CardView ev={ev} {...(response ? { response } : {})} />;
  const mine = ev.sender === USER_ID;
  const toMe = ev.recipient === USER_ID;
  if (!mine && !toMe) return <Delegation ev={ev} />;
  const intent = ev.decisions.intent;
  return (
    <article className={`msg ${mine ? 'me' : 'them'}`}>
      {!mine && (
        <div className="msg-head">
          <strong>{name(ev.sender)}</strong>
          {!ev.replyTo && <span className="tag">FYI</span>}
          <span className="muted small">{ago(ev.createdAt)}</span>
        </div>
      )}
      <Md text={ev.body} />
      <div className="msg-foot">
        {ev.tasks.map((t) => (
          <NodeChip key={t} id={t} />
        ))}
        {intent && (
          <span className="chip hint" title={`System One triage by ${intent.by}`}>
            {String(intent.value).replace('_', ' ')}
            {pct(intent.confidence)}
          </span>
        )}
        {mine && ev.state === 'open' && <span className="muted small">waiting for the Analyst</span>}
      </div>
      {changes && changes.count > 0 && <Changes because={ev.id} c={changes} />}
    </article>
  );
}

function Changes({ because, c }: { because: string; c: Timeline['changes'][string] }) {
  const { name } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <details className={`changes ${c.undone ? 'undone' : ''}`}>
      <summary>
        {c.undone ? 'Undone: ' : ''}
        {name(ANALYST_ID)} changed {c.count} thing{c.count === 1 ? '' : 's'}
        {!c.undone && (
          <button
            className="ghost small"
            disabled={busy}
            onClick={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await api.undo(because);
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Undo2 size={14} /> Undo
          </button>
        )}
      </summary>
      <ul>
        {c.lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
      {error && <p className="error">{error}</p>}
    </details>
  );
}

function Delegation({ ev }: { ev: Event }) {
  const { name } = useApp();
  const first = ev.body.split('\n')[0] ?? '';
  return (
    <details className="delegation">
      <summary>
        <span>{name(ev.sender)}</span> <ArrowRight size={12} /> <span>{name(ev.recipient)}</span>
        <span className="muted">
          {ev.kind === 'assign' ? ` · ${ev.state}` : ev.closes ? ' · done' : ' · note'} · {first.slice(0, 90)}
        </span>
      </summary>
      <Md text={ev.body} />
      {Object.entries(ev.decisions).length > 0 && (
        <p className="muted small">
          {Object.entries(ev.decisions)
            .map(([k, d]) => `${k}: ${String(d.value)} (${d.by}${pct(d.confidence)})`)
            .join(' · ')}
        </p>
      )}
    </details>
  );
}

function Composer() {
  const { focus, name, pendingRefs, clearRefs, byId } = useApp();
  const [text, setText] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  // "Reference in chat" from the graph lands here, at the cursor.
  useEffect(() => {
    if (!pendingRefs.length) return;
    const links = pendingRefs.map((id) => byId.get(id)).filter((n) => n !== undefined).map(nodeLink).join(' ');
    clearRefs();
    if (!links) return;
    const el = box.current;
    const at = el?.selectionStart ?? text.length;
    const before = text.slice(0, at);
    const after = text.slice(el?.selectionEnd ?? at);
    setText(`${before}${before && !/\s$/.test(before) ? ' ' : ''}${links} ${after}`.trimStart());
    setTimeout(() => {
      el?.focus();
      const end = (before + links).length + 2;
      el?.setSelectionRange(end, end);
    }, 0);
  }, [pendingRefs]); // eslint-disable-line react-hooks/exhaustive-deps
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.chat(text, focus);
      setText('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      {focus && <span className="muted small">About: {name(focus)}</span>}
      <div className="composer-row">
        <textarea
          ref={box}
          rows={2}
          value={text}
          placeholder="Ask, assign, or answer… (Enter sends, Shift+Enter for a new line)"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="btn primary" disabled={busy || !text.trim()} aria-label="Send">
          <Send size={16} />
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
