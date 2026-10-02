import { useMemo, useRef, useState } from 'react';
import type { Node, NodeKind } from '../shared/model';
import { useApp } from './App';
import { KindIcon } from './bits';
import { type Match, matchNodes } from './match';

/** A small search box over the graph's nodes: titles, then body text (decision lines are labelled). */
export function NodePicker(p: { placeholder: string; kinds?: NodeKind[]; exclude?: string[]; onPick(n: Node): void; autoFocus?: boolean }) {
  const { graph } = useApp();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => {
    const nodes = graph.nodes.filter((n) => (!p.kinds || p.kinds.includes(n.kind)) && !p.exclude?.includes(n.id));
    return matchNodes(nodes, q).slice(0, 12);
  }, [graph, q, p.kinds, p.exclude]);
  const pick = ({ node: n }: Match) => {
    p.onPick(n);
    setQ('');
    setOpen(false);
    input.current?.blur();
  };
  return (
    <div className="picker">
      <input
        ref={input}
        value={q}
        placeholder={p.placeholder}
        autoFocus={p.autoFocus}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          setHi(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setHi((h) => Math.min(h + 1, matches.length - 1));
          else if (e.key === 'ArrowUp') setHi((h) => Math.max(h - 1, 0));
          else if (e.key === 'Enter' && matches[hi]) {
            e.preventDefault();
            pick(matches[hi]);
          } else if (e.key === 'Escape') setOpen(false);
        }}
      />
      {open && matches.length > 0 && (
        <ul className="picker-list" role="listbox">
          {matches.map((m, i) => (
            <li key={m.node.id} role="option" aria-selected={i === hi} className={i === hi ? 'hi' : ''} onMouseDown={() => pick(m)}>
              <KindIcon kind={m.node.kind} />
              <span className="picker-text">
                <span className={m.node.status && m.node.status !== 'open' ? 'closed' : ''}>{m.node.title}</span>
                {m.line && (
                  <span className="picker-line">
                    {m.decision && <span className="tag">Decision</span>} {m.line}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
