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
| task | `guidance`: instructions for this task and everything it needs (inherited). `steward`: `true` shares the task and what it needs with the pod; an object is steward bookkeeping (§6). `private`: `true` keeps it and what it needs out of steward. Any other keys are allowed too (e.g. an agent's structured run state) and are not checked |
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
| `working_on` | person/team → task | They are doing it ("Will is working on X"; migration `010_working_on.sql`). The opposite direction of `involves`, which stays "coordinate with". Drawn muted and dashed |

**Computed, not stored:** whether a task is ready (open, everything it needs is closed, and no `waits_on`) and whether
it's a root (no task needs it). An open task's **state** says who can move it now: `ready` (anyone, an agent included;
green border), `yours` (it waits only on You; violet), `blocked` (it waits on another person, team, or resource;
yellow), `waiting` (on open subtasks; dashed), or `theirs` (someone other than You is `working_on` it; muted grey,
dotted). `theirs` wins over the others: it is never ready for you or your agents, and closing what it needs never
lists it in `nowReady`. MCP `graph` and `get_node` return it, so an agent picks `ready` work
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
- **The UI** shows them in a separate "Private notes" section with a lock icon. Editing there asks for a
  reason, the same rule as MCP: `/api/ops` uses the same `Op` schema, so a write without one is refused,
  and the reason lands in the audit log (`via: ui`).
- **Export rule (steward plug-in, `/api/steward/publish`, §6):** build what leaves the
  machine from `Node` (`store.mapNode`) only, never from a `nodes` row, `get_node`, or an audit
  snapshot. Audit `before`/`after` are whole rows, private notes included, and `reason` may quote
  them; nothing exported may read either. `steward.db.test.ts` checks publish and describe, over HTTP
  and through the exec script, never carry them.

**You** (`…0001`) is a person node created by the first migration. It can be edited but not deleted.

## 3. One change vocabulary

`create_node`, `update_node`, `delete_node`, `create_edge`, `update_edge`, `delete_edge`, applied
as a batch in one transaction (`ref` / `$ref` link new nodes). The web UI (`POST /api/ops`) and
Claude Code (`apply_ops` over MCP) use the same ops.

## 4. Runtime

```text
browser ──HTTP/SSE──► server (Fastify) ──► PostgreSQL
Claude Code ──MCP (/mcp)──►
steward daemon ──exec──► scripts/steward-backend-ariadne ──HTTP (/api/steward/*)──►
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
`009_drop_federation.sql` drops its tables and `nodes.home`). Sharing with the pod is **steward**'s job,
a separate project in its own repo. Ariadne is one steward back end through a small plug-in here
(`src/server/steward.ts`, `scripts/steward-backend-ariadne`). It follows the export rule under
**Private notes** (§2): build from `Node`, never from rows, `get_node`, or audit snapshots.

- **Kept:** person `attrs.peer`. It now names the **steward peer id** that maps a person node to a steward
  member (it used to name an Ariadne instance).
- **Left as they were:** nodes replicated here from another instance are now ordinary local nodes;
  audit rows with `via: sync` came from that replication. Undo still works on snapshots that name the
  dropped `home` column (it restores only columns the table still has).

### 6.1 The exec back end

The steward daemon runs `steward-backend-ariadne <verb>` with one JSON object on stdin and reads one
from stdout (steward's DESIGN.md §3). The script is POSIX `sh` + `curl`: it posts stdin to
`$ARIADNE_URL/api/steward/<verb>` (default `http://127.0.0.1:3100`), prints the answer, exits 3 for a verb
it doesn't know, and 1 on any HTTP or connection error. Wire shapes follow steward's `src/item.rs`:
snake_case keys, times in Unix seconds, `audience` a list of peer ids (empty: the whole pod).

**Who may call:** the same guard as `/mcp` (only the allowed loopback `Host`), and the steward routes also
refuse any request with an `Origin` header. Browsers always send one on a POST, so no web page, this UI
included, can read the feed or plant a ticket. The server listens on `0.0.0.0` inside its container, so a
client-IP check would not help; the published port is bound to loopback.

| Verb | In | Out |
|---|---|---|
| `describe` | `{}` | `{ name: "ariadne", owner: You's title, areas: You's attrs.areas, repos: repos of the shared work, capabilities: ["ticket", "answer", "intent"] }` |
| `publish` | `{ since? }` | `{ cursor, upserts: Item[], removed: id[], full? }` |
| `receive` | `{ ticket, from_name? }`, `{ answer, from?, from_name? }`, or `{ intent, from, from_name? }` | `{ localRef: node id }` |

**publish: what is shared.** Opted-in roots (`attrs.steward === true`) and every task they transitively
need. A task with `attrs.private: true` is pruned with everything below it (unless another shared path
reaches it). Tasks steward itself made (asks, unmatched answers, intents) are never published as work:
they are a teammate's content.

| Item | From |
|---|---|
| `work` (id = node id) | title; `body`; `state` (open: ready / yours / blocked / waiting, with theirs sent as blocked; else done / dropped); `repos`, `branch`, `pr_url` from the task's own attrs (`repo`, `repos`, `branch`, `pr_url`), then the repo / branch / PR-link resources it or a task that needs it uses (nearest first), then a GitHub PR URL in its body; `published` from `attrs.published`, else true when a PR is known |
| `decision` (id = `<node id>:decision:<hash of the line>`) | each decision line; `relates_to` the task |
| `answer` (id = `<node id>:answer`) | the Answer lines of an Ask task (each with the rest of its paragraph); `relates_to` the ticket, `audience` the asker only. steward sends targeted items by letter, never in the feed |

Bodies over 16 KiB (steward's limit) are clipped.

**publish: the cursor.** `"<newest audit id>-<audit row count>"`. Every graph change adds audit rows, and
the count also catches a transaction that commits after a newer id was read. If `since` equals the
current cursor, the answer is empty. Otherwise it is the **whole current set** with `full: true` (steward
drops unchanged items itself and removes any it holds that are missing), plus a best-effort `removed`:
tasks touched since `since`, or below one that was, that are no longer shared (deleted, un-opted, made
private, cut loose). `removed` may name ids that were never published; ids only, never content, and it
reads only audit ids and edge endpoints, never a node snapshot. Closed work is not removed: it stays with
state `done` or `dropped`, so a teammate's replica sees that it ended.

**receive.**
- **Ticket** → task "Ask (Name): question" with the question, sender, ticket id, repo, and context in its
  body, `attrs.steward = { kind: "ask", ticket, from }`, `waits_on` You (your queue, violet), `involves` the
  sender, and needed by each open task its `relates_to` names (an item id is a node id, or starts with
  one). Redelivery returns the same task. You answer by appending `**Answer (Name, YYYY-MM-DD):** ...` and
  closing it; the next publish sends those lines to the asker.
- **Answer** → appended as `**Answer (Name, date):** text` to the open task whose `attrs.steward.ticket`
  is in the answer's `relates_to` (your "Waiting on Name: ..." leaf, which your agent tags
  `{ kind: "waiting", ticket, to }` when it asks), which it then closes. Redelivery adds nothing. An answer
  nothing here waits for becomes "Answer (Name): ..." waiting on You, so it isn't lost.
- **Intent** → task "Intent (Name): title" (body: their text, then repos, branch, PR, and paths), with
  `attrs.steward = { kind: "intent", peer, itemId, expiresAt }` and a `working_on` edge from their person
  node, so it is `theirs`. One task per (peer, item id): redelivery updates it in place, a renewed expiry
  reopens it, and the author's `state: done | dropped` closes it. Without `expires_at` it lasts 7 days from
  its `updated_at`. Intents are never published back.
- **Expiry:** an intent that arrives already expired is stored dropped. The server drops open intents past
  `expiresAt` at start-up, every 5 minutes, and before each `receive` (`dropExpiredIntents`), appending a
  `**Result (date):**` line. Dropped, not deleted, so history keeps what a teammate planned.
- **The sender** is the person whose `attrs.peer` is the steward peer id, created (titled `from_name`, or
  "Steward peer …<id>") if missing. Changes are audited with `via: steward` and that person as the actor.

### 6.2 Decisions

| Date | Decision |
|---|---|
| 2026-10-14 | Private notes are editable in the UI with a required reason field, not only through Claude Code; reads stay default-deny (node view only). (Karl, 2026-10-14) |
| 2026-10-14 | Publish is stateless: the full set with `full: true` whenever the audit log moved, rather than a table of what was published. steward already diffs against its own feed, and a stateless back end can't drift from it. Flip: add a `steward_published (item_id, hash, seq)` table and send true deltas. (Karl, 2026-10-14) |
| 2026-10-14 | The cursor is the newest audit row id plus the row count, not a changeset id: changeset ids are UUIDs with no order. (Karl, 2026-10-14) |
| 2026-10-14 | Closed work stays published with state done / dropped; only un-shared or deleted tasks are removed. Teammates see that work ended. (Karl, 2026-10-14) |
| 2026-10-14 | `attrs.steward` is the opt-in only when it is exactly `true`; an object is bookkeeping on tasks steward made or tracks (`kind`: ask, waiting, answer, intent). One key, no clash with design 11's intent attrs. (Karl, 2026-10-14) |
| 2026-10-14 | A ticket's Ask task is needed by the tasks it is about, so the question shows in that subtree and the task waits until you answer. (Karl, 2026-10-14) |
| 2026-10-14 | Answer items come only from Ask tasks (they have a ticket and an asker), not from Answer lines anywhere in a shared subtree. (Karl, 2026-10-14) |
| 2026-10-14 | The script lives in `scripts/` (this repo has no `bin/`), and the steward routes refuse any `Origin`. (Karl, 2026-10-14) |
| 2026-10-14 | `theirs` takes precedence over every other open state, and You working on a task changes nothing. A teammate's work is never yours to pick up, whatever it waits on. (Karl, 2026-10-14) |
| 2026-10-14 | Expired intents are dropped by a periodic sweep (5 minutes, plus start-up and each `receive`), not hidden on read: the stored status stays the truth for readiness, search, and the graph, and the drop is audited. Flip: filter on read in `graph()` instead. (Karl, 2026-10-14) |
| 2026-10-14 | An intent without `expires_at` lasts 7 days from its `updated_at`. (Karl, 2026-10-14) |
| 2026-10-14 | steward has no `theirs` state, so publish sends a theirs task as `blocked`. (Karl, 2026-10-14) |
