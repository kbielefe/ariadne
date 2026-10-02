// Search over the graph's nodes for the pickers.
import { isDecisionLine } from '../shared/graph';
import type { Node } from '../shared/model';

export interface Match {
  node: Node;
  /** The body line that matched, when the title didn't. */
  line?: string;
  decision?: boolean;
}

/** Title matches first, then body matches (with the matching line); open before closed. */
export function matchNodes(nodes: readonly Node[], q: string): Match[] {
  const needle = q.trim().toLowerCase();
  const closed = (n: Node) => (n.status && n.status !== 'open' ? 1 : 0);
  const out: (Match & { rank: number })[] = [];
  for (const node of nodes) {
    if (!needle || node.title.toLowerCase().includes(needle)) {
      out.push({ node, rank: closed(node) });
      continue;
    }
    const line = node.body.split('\n').find((l) => l.toLowerCase().includes(needle));
    if (line) out.push({ node, line: line.trim().replace(/\*\*/g, ''), decision: isDecisionLine(line), rank: 2 + closed(node) });
  }
  return out.sort((a, b) => a.rank - b.rank);
}
