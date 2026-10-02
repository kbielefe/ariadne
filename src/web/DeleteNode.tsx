import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { Op } from '../shared/model';
import type { NodeDetail } from './api';
import { useApp } from './App';
import { NodeChip } from './bits';

/**
 * Delete button with an inline confirm step. Deletion goes through the normal `delete_node` op, which
 * audits the node and every edge it cascades, so it can be undone. Deleting is allowed even when open
 * tasks still use the node (a resource via `uses`, an actor via `involves`): the confirm warns and lists them.
 */
export function DeleteNode({ detail: d, run, onDeleted }: { detail: NodeDetail; run(ops: Op[]): Promise<{ changeset: string } | null>; onDeleted(): void }) {
  const { byId, notify } = useApp();
  const [asking, setAsking] = useState(false);
  const n = d.node;
  if (!asking)
    return (
      <button className="btn small danger" onClick={() => setAsking(true)}>
        <Trash2 size={14} /> Delete
      </button>
    );
  // Tasks pointing at this node (uses / involves / needs).
  const users = d.edges.filter((e) => e.dst === n.id && byId.get(e.src)?.kind === 'task').map((e) => e.src);
  const open = [...new Set(users)].filter((t) => byId.get(t)?.status === 'open');
  const verb = n.kind === 'resource' ? 'use' : n.kind === 'task' ? 'need' : 'involve';
  return (
    <div className="confirm-delete" role="alertdialog" aria-label={`Delete ${n.title}?`}>
      <p>
        Delete <strong>{n.title}</strong> and its {d.edges.length} connection{d.edges.length === 1 ? '' : 's'}?
      </p>
      {open.length > 0 && (
        <>
          <p className="warn">
            {open.length === 1 ? `1 open task still ${verb}s it:` : `${open.length} open tasks still ${verb} it:`}
          </p>
          <div className="chips">
            {open.map((t) => (
              <NodeChip key={t} id={t} />
            ))}
          </div>
        </>
      )}
      <p className="muted small">You can undo it right after, or later by asking the Analyst (MCP history / undo).</p>
      <div className="row">
        <button className="btn small danger" autoFocus onClick={async () => {
            const done = await run([{ op: 'delete_node', id: n.id }]);
            if (!done) return;
            notify(`Deleted ${n.title}.`, done.changeset);
            onDeleted();
          }}
        >
          <Trash2 size={14} /> Delete
        </button>
        <button className="btn small" onClick={() => setAsking(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
