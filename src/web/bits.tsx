import { Bot, CircleDot, FileText, ListTodo, User, Users } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { NodeKind } from '../shared/model';
import { useApp } from './App';

export function KindIcon({ kind, size = 14 }: { kind: NodeKind; size?: number }) {
  const I = { task: ListTodo, person: User, agent: Bot, team: Users, resource: FileText }[kind] ?? CircleDot;
  return <I size={size} aria-label={kind} className={`kind-${kind}`} />;
}

/** Markdown without raw HTML; links open in a new tab. */
export function Md({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div className="md">
      <Markdown remarkPlugins={[remarkGfm]} components={{ a: (p) => <a {...p} target="_blank" rel="noreferrer" /> }}>
        {text}
      </Markdown>
    </div>
  );
}

/** A task (or any node) as a clickable chip that opens it in the graph. */
export function NodeChip({ id }: { id: string }) {
  const { byId, show } = useApp();
  const n = byId.get(id);
  if (!n) return <span className="chip muted">(deleted)</span>;
  return (
    <button className={`chip ${n.status && n.status !== 'open' ? 'closed' : ''}`} onClick={() => show(id)} title={`Open "${n.title}" in the graph`}>
      <KindIcon kind={n.kind} size={12} /> {n.title}
    </button>
  );
}

export const pct = (c?: number) => (c == null ? '' : ` · ${Math.round(c * 100)}%`);

export function ago(iso: string): string {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}
