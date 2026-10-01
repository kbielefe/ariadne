// Imports a v1 export (scripts/export-v1.sql) into a running Ariadne v2 through its normal API,
// so the whole import is one audited batch that can be undone from the history.
//   pnpm tsx scripts/import-v1.ts var/v1.json [--url http://127.0.0.1:3100] [--dry-run] [--force]
//
// Mapping:
//   people, teams        → person, team nodes ("You" merges into the existing You). Retired ones are skipped.
//   services             → resource nodes (type "other"); the scheduler and retired services are skipped.
//   areas                → attrs.areas on the owning team
//   member-of            → member_of;  supervised-by → reports_to
//   contact-for / owns   → written into the team's description (v2 has no edge for them)
//   outcome              → a root task: it needs its top-level tasks
//   task                 → task; parent → needs; "waits for" (prerequisite_ids) → needs
//   complete/done        → done;  complete/superseded|canceled → dropped;  everything else → open
//   claude-docs / git refs → resource nodes + a "uses" edge from the task (note = the section label)
//   blocking stakeholder → involves edge
//   assignments (all to you) are not imported: v2 derives "yours" from open cards and the Analyst.
import { readFileSync } from 'node:fs';
import { USER_ID, type Op } from '../src/shared/model';

interface V1 {
  participants: { id: string; type: string; name: string; role: string | null; status: string }[];
  areas: { participant_id: string; relation: string; subject: string }[];
  relationships: { subject_ref: string; predicate: string; object_ref: string }[];
  outcomes: { id: string; title: string; why_it_matters: string | null; completion_condition: string | null; blocker: string | null; completed_at: string | null }[];
  tasks: {
    id: string;
    outcome_id: string;
    title: string;
    completion_condition: string | null;
    constraints: string | null;
    required_inputs: string[];
    notes: string | null;
    state: string;
    state_reason: string | null;
    resolution: string | null;
    parent_task_id: string | null;
    prerequisite_ids: string[];
  }[];
  stakeholders: { task_id: string; participant_id: string; mode: string }[];
  references: { subject_id: string; system: string; kind: string; key: string; url: string | null; label: string | null }[];
}

const args = process.argv.slice(2);
const urlAt = args.indexOf('--url');
const base = urlAt >= 0 ? args[urlAt + 1]! : 'http://127.0.0.1:3100';
const file = args.find((a, i) => !a.startsWith('--') && i !== (urlAt >= 0 ? urlAt + 1 : -1));
const dry = args.includes('--dry-run');
const force = args.includes('--force');
if (!file) throw new Error('Usage: import-v1.ts <export.json> [--url URL] [--dry-run] [--force]');
const v1 = JSON.parse(readFileSync(file, 'utf8')) as V1;

const SKIP_SERVICES = new Set(['Ariadne scheduler']);
const ORG_SUFFIX = / \(organization [^)]*\)$/;
const ops: Op[] = [];
const ref = (kind: string, id: string) => `${kind}:${id}`;
const bodyOf = (...parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join('\n\n');

// ---------------------------------------------------------------- actors
const byId = new Map(v1.participants.map((p) => [p.id, p]));
const live = (p: V1['participants'][number]) => p.status !== 'retired';
const you = v1.participants.find((p) => p.name === 'You');
const actorRef = (id: string) => (id === you?.id ? USER_ID : `$${ref('p', id)}`);
const imported = new Set<string>();

const contacts = new Map<string, string[]>();
const owns = new Map<string, string[]>();
for (const r of v1.relationships) {
  const a = byId.get(r.subject_ref);
  const b = byId.get(r.object_ref);
  if (!a || !b) continue;
  if (r.predicate === 'contact-for') contacts.set(b.id, [...(contacts.get(b.id) ?? []), a.name]);
  if (r.predicate === 'owns') owns.set(a.id, [...(owns.get(a.id) ?? []), b.name]);
}
const ownedBy = new Map<string, string>();
for (const [owner, things] of owns) for (const t of things) ownedBy.set(t, byId.get(owner)!.name);

for (const p of v1.participants.filter(live)) {
  if (p.type === 'service') {
    if (SKIP_SERVICES.has(p.name)) continue;
    ops.push({ op: 'create_node', ref: ref('p', p.id), kind: 'resource', title: p.name, body: bodyOf(ownedBy.has(p.name) && `Owned by ${ownedBy.get(p.name)}.`), attrs: { type: 'other' } });
    imported.add(p.id);
  } else if (p.id === you?.id) {
    ops.push({ op: 'update_node', id: USER_ID, body: bodyOf(p.role) });
    imported.add(p.id);
  } else {
    const areas = v1.areas.filter((a) => a.participant_id === p.id).map((a) => a.subject.replace(ORG_SUFFIX, ''));
    const kind = p.type === 'team' ? 'team' : 'person';
    const contact = contacts.get(p.id);
    const body = bodyOf(p.role, contact && `Contact: ${contact.join(', ')}.`, p.status === 'unknown' && 'Status unknown (not staffed yet).');
    ops.push({ op: 'create_node', ref: ref('p', p.id), kind, title: p.name, body, attrs: areas.length ? { areas } : {} });
    imported.add(p.id);
  }
}
for (const r of v1.relationships) {
  if (!imported.has(r.subject_ref) || !imported.has(r.object_ref)) continue;
  if (r.predicate === 'member-of') ops.push({ op: 'create_edge', src: actorRef(r.subject_ref), kind: 'member_of', dst: actorRef(r.object_ref) });
  if (r.predicate === 'supervised-by') ops.push({ op: 'create_edge', src: actorRef(r.subject_ref), kind: 'reports_to', dst: actorRef(r.object_ref) });
}

// ---------------------------------------------------------------- tasks
const resolved = (t: V1['tasks'][number]) => (t.state !== 'complete' ? 'open' : t.resolution === 'done' ? 'done' : 'dropped');
for (const o of v1.outcomes) {
  ops.push({
    op: 'create_node',
    ref: ref('o', o.id),
    kind: 'task',
    title: o.title,
    status: o.completed_at ? 'done' : 'open',
    body: bodyOf(o.why_it_matters && `**Why it matters:** ${o.why_it_matters}`, o.completion_condition && `**Done when:** ${o.completion_condition}`, o.blocker && `**Blocked by:** ${o.blocker}`),
  });
}
const taskIds = new Set(v1.tasks.map((t) => t.id));
for (const t of v1.tasks) {
  ops.push({
    op: 'create_node',
    ref: ref('t', t.id),
    kind: 'task',
    title: t.title,
    status: resolved(t),
    body: bodyOf(
      t.completion_condition && `**Done when:** ${t.completion_condition}`,
      t.constraints && `**Constraints:** ${t.constraints}`,
      t.required_inputs.length > 0 && `**Needs input:** ${t.required_inputs.join('; ')}`,
      t.state_reason && `**${t.state}:** ${t.state_reason}`,
      t.notes && `**Notes:** ${t.notes}`,
    ),
  });
}
const need = (src: string, dst: string, note?: string) => ops.push({ op: 'create_edge', src, kind: 'needs', dst, ...(note ? { note } : {}) });
for (const t of v1.tasks) {
  if (t.parent_task_id && taskIds.has(t.parent_task_id)) need(`$${ref('t', t.parent_task_id)}`, `$${ref('t', t.id)}`);
  else need(`$${ref('o', t.outcome_id)}`, `$${ref('t', t.id)}`); // top-level tasks make up the outcome
  for (const pre of t.prerequisite_ids) if (taskIds.has(pre)) need(`$${ref('t', t.id)}`, `$${ref('t', pre)}`, 'waits for');
}
for (const s of v1.stakeholders) if (imported.has(s.participant_id)) ops.push({ op: 'create_edge', src: `$${ref('t', s.task_id)}`, kind: 'involves', dst: actorRef(s.participant_id), note: `${s.mode} stakeholder` });

// ---------------------------------------------------------------- references
const docs = new Map<string, string>();
for (const r of v1.references) {
  const key = `${r.system}:${r.key}`;
  const title = r.kind === 'doc' ? r.label!.replace(/, section \d+$/, '') : r.label || r.key;
  if (!docs.has(key)) {
    docs.set(key, ref('r', key));
    ops.push({ op: 'create_node', ref: docs.get(key)!, kind: 'resource', title, attrs: { type: r.kind === 'doc' ? 'doc' : r.kind === 'branch' ? 'repo' : 'link', ...(r.url ? { url: r.url } : {}) }, ...(r.kind === 'branch' ? { body: `Git branch \`${r.key}\`.` } : {}) });
  }
  const section = /section \d+$/.exec(r.label ?? '')?.[0];
  ops.push({ op: 'create_edge', src: `$${ref('t', r.subject_id)}`, kind: 'uses', dst: `$${docs.get(key)!}`, ...(section ? { note: section } : {}) });
}

// ---------------------------------------------------------------- run
const counts = ops.reduce<Record<string, number>>((c, o) => ((c[o.op] = (c[o.op] ?? 0) + 1), c), {});
console.log(`${ops.length} operations`, counts);
if (dry) process.exit(0);

const graph = (await (await fetch(`${base}/api/graph`)).json()) as { nodes: unknown[] };
if (graph.nodes.length > 2 && !force) throw new Error(`${base} already has ${graph.nodes.length} nodes. Importing twice would duplicate everything; use --force if you mean it.`);
const res = await fetch(`${base}/api/ops`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops }) });
if (!res.ok) throw new Error(`Import failed, nothing was changed: ${await res.text()}`);
console.log('Imported. To undo, use the history (all ops share one changeset).');
