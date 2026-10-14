# Ariadne design

**Summary:** Ariadne is a **graph** (tasks, people, teams, resources) with an **audit trail**. You keep
it up to date by directing **Claude Code** in an interactive session (over MCP), and browse or edit it
in a **graph view**. It's a task and org tracker: trusted external memory for the bigger picture and
what's next, so they survive interruptions and session changes.

---

## 1. History

| When | What | Why |
|---|---|---|
| v1 (`v1` branch) | Outcomes, tasks, plans, reviews... (~25 tables), pages and forms | Felt like data entry or a bug tracker |
| v2, 2026-10-01 | Graph + events (assign / report), an Analyst agent, cards, claims, RabbitMQ runners, System One dispatch | An interactive, AI-decision-oriented tool |
| 2026-10-02 | **Graph + audit only.** Removed the Analyst, events, cards, claims, timers, RabbitMQ, runners, agents, and System One | In practice the user just directed Claude Code in an interactive session, using Ariadne as a task and org tracker. The graph view was what earned its place |
| 2026-10-14 | Private notes; **federation removed** | Sharing moves to steward (its own repo), which needs a field that never leaves the machine. Two instances sharing a subgraph was more machinery than it earned |

Kept from v2: one task edge kind (`needs`), root tasks instead of Outcomes, inherited context, decision
lines, branch scopes, and undo.

## 2. Data model

| Table | Holds |
|---|---|
| `nodes` | `kind` = task / person / team / resource, plus `title`, `body` (markdown), `private_notes` (markdown, see below), `status` (tasks only: open / done / dropped), and `attrs` (checked per kind) |
| `edges` | `src -kind-> dst` with an optional `note` |
| `audit` | Every change, with who made it (`actor`: you for the UI, null for MCP), how (`via`: `ui` / `mcp`), and, when the change must say why, a `reason`. Grouped into changesets for Undo |

**Attrs per kind**

| Kind | Attrs |
|---|---|
| task | `guidance`: instructions for this task and everything it needs (inherited). Any other keys are allowed too (e.g. an agent's structured run state) and are not checked |
| person, team | `areas`: what they own or can help with; `peer`: the steward peer id of the member this person is |
| resource | `type` (repo / branch / build / doc / link / other), `url`; for a branch, `repo` and `branch` |

**Edge kinds**

| Kind | From → to | Meaning |
|---|---|---|
| `needs` | task → task | Must be done first (subtask or blocker). Acyclic |
| `uses` | task → resource | Repo, branch, Jenkins build, library docs, link |
| `involves` | task → person/team | Coordinate with them |
| `reports_to` | person/team → person/team | Supervisor. Acyclic |
| `member_of` | person/team → team | Acyclic |
| `waits_on` | task → person/team/resource | Blocked outside your control: a PR review, CI build, merge, or answer. Drawn yellow. To You: waiting on your own action, drawn violet |

**Computed, not stored:** whether a task is ready (open, everything it needs is closed, and no `waits_on`) and whether
it's a root (no task needs it). An open task's **state** says who can move it now: `ready` (anyone, an agent included;
green border), `yours` (it waits only on You; violet), `blocked` (it waits on another person, team, or resource;
yellow), or `waiting` (on open subtasks; dashed). MCP `graph` and `get_node` return it, so an agent picks `ready` work
and leaves `yours` to you. When `apply_ops` closes tasks, its answer lists the tasks that just
became ready (`nowReady`), so the next step is never silent.

**Waiting on someone:** an external blocker is a leaf task ("Waiting on review: <repo> PR #48") that
`waits_on` the reviewer, team, or build, and is needed by what it blocks. While open it's **blocked**
(yellow in the graph), not ready. Closing it unblocks its parents and reports them in `nowReady`; the
edge stays as history. Why a leaf and not an edge on the blocked task: closing a task keeps the history
and the `nowReady` signal, where deleting an edge would lose both.

**Waiting on you:** the same shape, pointed at You. When an agent finishes work that needs your action, it adds
a leaf "Review: <what>" (a branch to push, a PR to open, a draft to send) or "Decide: <question>" (including a
provisional decision to confirm) that `waits_on` You, with the exact command or draft in its body. Your queue is
`graph` from You, up, `waits_on`; in the graph view it's the violet tasks. Why You and not a new attr or status: the
edge already means "blocked until this one acts", the leaf keeps history and `nowReady`, and nothing new has to be
kept in sync.

**Inheritance:** a task's context includes the guidance, resources, and `involves` people of every
task that (transitively) needs it. Attach a repo to a root task once, and all its subtasks get it.

**Decisions** (yours or anyone's) are lines in the body of the task they shape:
`**Decision (Karl, 2026-10-02):** skip signing for now`. No table or node kind: the sidebar shows
them with the body, and MCP `search` with `decisions: true` finds only nodes that have them and returns
the lines. The MCP instructions tell Claude to record them this way.

**Branches are shared scopes:** a resource with `attrs.type` `branch` (plus `repo` and `branch`)
groups work that ships in one PR. Every task that uses it, and everything those tasks need, is in
its scope. `get_node` on a task lists each branch it ships on with every task in that scope.

**Private notes** (migration `008_private_notes.sql`): every node has a public `body` and separate
`private_notes`. This is the one deliberate exception to the simple schema, so the two can be treated
differently (e.g. separate vectors later). The body is preferred, because it may be shared with the pod
through steward. Private notes are for what must never leave this machine: opinions about people,
personnel or HR matters, unannounced plans, other teams' confidential details, pointers to where
credentials live, and anything that would embarrass someone if shared.

- **Every write needs a reason.** `create_node` / `update_node` take `privateNotes` (replace) or
  `privateAppend` only together with `privateReason`, and `privateReason` only with one of them (a zod
  refine on the op). The reason goes in `audit.reason`, so `history` shows why.
- **Default-deny reads.** The `Node` type (graph, search results, neighbors, inherited context) never
  carries them. Only the node view (`get_node`, `/api/nodes/:id`) adds `node.privateNotes`, for the
  local user. Owner-side `search` matches them but doesn't return them.
- **The UI** shows them in a separate "Private notes" section with a lock icon, read-only: a write needs
  a reason, so it goes through Claude Code.
- **Export rule (steward plug-in, `/api/steward/publish`, still to build):** build what leaves the
  machine from `Node` (`store.mapNode`) only, never from a `nodes` row, `get_node`, or an audit
  snapshot. Audit `before`/`after` are whole rows, private notes included, and `reason` may quote
  them; nothing exported may read either. A test must cover this when the export lands.

**You** (`…0001`) is a person node created by the first migration. It can be edited but not deleted.

## 3. One change vocabulary

`create_node`, `update_node`, `delete_node`, `create_edge`, `update_edge`, `delete_edge`, applied
as a batch in one transaction (`ref` / `$ref` link new nodes). The web UI (`POST /api/ops`) and
Claude Code (`apply_ops` over MCP) use the same ops.

## 4. Runtime

```text
browser ──HTTP/SSE──► server (Fastify) ──► PostgreSQL
Claude Code ──MCP (/mcp)──►
```

- **MCP tools:** `get_node` (a node with its edges; for a task, readiness, inherited context, and
  branches), `search` (text, kind, status, `decisions`), `graph` (reachable subgraph, or roots and
  actors), `history`, `apply_ops`, `undo`. Stateless Streamable HTTP, no token: localhost only.
- **SSE:** browsers refetch on `changed`.
- **Undo:** `history` (grouped by changeset) and `undo` over MCP. An undo is refused if something
  changed again since. In the UI, a delete shows a short "Deleted … Undo" message (`/api/ops` returns
  its changeset; `POST /api/undo`). A fuller history view is still to be designed.

## 5. Screens

- **Graph** (the only screen): all nodes and edges with filters (kinds, hide closed) and **focus**: pick a node to see
  what's reachable from it (down / up / both, with a depth). A side panel creates, edits, and deletes
  nodes and edges.
- **Search:** the pickers (focus, add edge) match titles first, then body text, showing the matching
  line; decision lines are labelled, so typing "decision" lists them.
- **Focus:** the focus task in the top bar is remembered across reloads. While focused, a **Show all** button on
  the canvas returns to the full graph.
- **Order:** a control in the left sidebar sets how side-by-side nodes are ordered in the layout: ready first,
  oldest first, newest first, recently updated, or title. Changing it lays the graph out again; it is remembered.
  dagre may still move a node with children to avoid edge crossings; leaves always follow the order.

## 6. Sharing with the pod (steward)

Ariadne no longer talks to other instances. The libp2p federation (shares, home peers, proposals,
relay spool, the `/p2p` WebSocket and its tunnel) was removed in 2026-10 (migration
`009_drop_federation.sql` drops its tables and `nodes.home`). Sharing with the pod moves to
**steward**, a separate project in its own repo; Ariadne will be one steward back end through a small
plug-in in this repo (`/api/steward/*`, not built yet). That plug-in must follow the export rule under
**Private notes** (§2): build from `Node`, never from rows, `get_node`, or audit snapshots.

- **Kept:** person `attrs.peer`. It now names the **steward peer id** that maps a person node to a steward
  member (it used to name an Ariadne instance).
- **Left as they were:** nodes replicated here from another instance are now ordinary local nodes;
  audit rows with `via: sync` came from that replication. Undo still works on snapshots that name the
  dropped `home` column (it restores only columns the table still has).
