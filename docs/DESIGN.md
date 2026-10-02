# Ariadne v2 design

**Summary:** Ariadne is a **graph** (tasks, people, agents, teams, resources) plus a **log of
events** (assign and report). You talk to the Analyst in an **interactive Claude Code session**
that claims its events over MCP, and browse or edit everything in a **graph view**. Things for you
(questions, notes) are events too: a session claims them and asks or tells you. Headless agents
work only through assignments and reports on RabbitMQ.

Agreed on 2026-10-01, after using v1 for real work (v1 is on the `v1` branch). The web chat
timeline was removed the same day: an interactive Claude Code session over MCP was the better
conversation, at least until there is a better inference source.

---

## 1. What changed from v1, and why

| v1 | v2 | Why |
|---|---|---|
| Outcomes + Tasks + Dependencies + Plans + Reviews + ... (~25 tables) | **5 tables**: `nodes`, `edges`, `events`, `event_tasks`, `audit` (+ `timers`, §5) | v1 felt like data entry or a bug tracker |
| Outcome | A **root task**: a task that no task `needs` | One concept instead of two |
| Subtask *and* prerequisite | One edge kind: **A `needs` B** | Breaking work down and blocking on something are the same thing |
| Pages and forms | **Claude Code session** + **graph view** | Interactive, not data entry |
| Agents call MCP | **Only the Analyst** changes the graph over MCP | Agents are decoupled; all changes go through one place |

Kept from v1: people, agents, and teams as first-class actors; System One (Jev-like) decisions;
RabbitMQ to decouple agents from the core.

## 2. Data model

| Table | Holds |
|---|---|
| `nodes` | `kind` = task / person / agent / team / resource, plus `title`, `body` (markdown), `status` (tasks only: open / done / dropped), and `attrs` (checked per kind) |
| `edges` | `src -kind-> dst` with an optional `note` |
| `events` | `assign` / `report` (§3) |
| `event_tasks` | Which tasks an event is about (many-to-many, so events can share tasks) |
| `audit` | Every change, with who made it, how (`ui` / `mcp` / `core` / `bus`), and which event it was handling. Grouped into changesets for Undo |

**Edge kinds**

| Kind | From → to | Meaning |
|---|---|---|
| `needs` | task → task | Must be done first (subtask or blocker). Acyclic |
| `uses` | task → resource | Repo, Jenkins build, library docs, link |
| `involves` | task → actor | Coordinate with this person, agent, or team |
| `reports_to` | actor → actor | Supervisor. Acyclic |
| `member_of` | person/agent → team | |

**Computed, not stored:** whether a task is ready (open, and everything it needs is closed), who it's
assigned to (open assignments), and whether it's a root.

**Inheritance:** a task's context includes the guidance, resources, and `involves` people of every
task that (transitively) needs it. Attach a repo to a root task once, and all its subtasks get it.

**Well-known actors:** *You* (`…0001`) and *Analyst* (`…0002`, which reports to you). They can be
edited but not deleted.

### Where each AI decision lives

| Decision | Read from | Result written to |
|---|---|---|
| Model and effort | Agent `attrs.models` (cheapest first) and `effort`, plus the task | The assign event's `decisions` |
| Break down a task | The task and its inherited context | New tasks + `needs` edges |
| Who to coordinate with | Actors' `areas` | `involves` edges |
| Context, repos, Jenkins | Nearby resources | `uses` edges |
| On receiving an assignment / returning results | The recipient's `briefs.onAssignment` / `onReport` + the event's `instructions` | — |
| On assigning / receiving results | The assigner's `briefs.onDelegate` / `onReview` | — |

Each entry in `decisions` records `by` (jev / analyst / default / user) and `confidence`.

## 3. Events: assign and report only

- **Assign:** a sender gives a recipient work about some tasks.
- **Report:** replies to an assignment, from its recipient back to its sender. `closes` finishes it.
  A report with no `replyTo` is an FYI.

The user is just another actor:

| Thing | Is |
|---|---|
| You talk to the Analyst | Directly, in the Claude Code session (not an event) |
| A question left for you (`ask_user`) | An assign event to you, with `card` (title, fields, options) |
| A note left for you (`tell_user`, Ariadne's notices, reminders) | A report to you, with no `replyTo` |
| Your answer | Your report: a session asks you, then calls `submit_result` with your answer |
| Work for another person or team | A **proxy card** for you ("Ask Bryan"). Your answer becomes *their* report; a non-final answer is "Not reached yet" |
| An agent's result | A report over the inbox. It can carry `proposals` (ops) that the Analyst applies or escalates |
| A System One question | An assign event to a decider agent, with `questions`; the answer is a report with `answers` |

**Who may assign to whom:** you assign only to the Analyst. The Analyst and Ariadne may assign to
anyone. Other agents may assign only to their direct subordinates (and to deciders).

**Delivery:** an event to an agent is `pending` until the relay publishes it, then `delivered`. For
an interactive agent (the Analyst, or any agent with `attrs.interactive`) **or for you**, it is
`pending` until a session claims it (`claimed`), then `delivered` when the session finishes. It is
`held` while Ariadne waits for a System One decision, and `none` for other people and teams (they
get a proxy card instead).

## 4. One change vocabulary

`create_node`, `update_node`, `delete_node`, `create_edge`, `update_edge`, `delete_edge`,
`update_event`, `delete_event`, applied as a batch in one transaction (`ref` / `$ref` link new
nodes). The same ops are used by:

- the web UI (`POST /api/ops`). Your edits apply directly and are audited, and the Analyst sees
  them in its next delivery (`analyst.userChanges`);
- the Analyst (`apply_ops` over MCP);
- agents, as `proposals` inside reports.

## 5. Runtime

```text
browser ──HTTP/SSE──► server (Fastify) ──► PostgreSQL
                         │  ▲
            relay publish │  │ inbox consume
                         ▼  │
                       RabbitMQ
         ariadne.deliver → ariadne.actor.<id>      ariadne.inbox ◄── runners
                         │
          runners: agents (claude -p, no Ariadne MCP), deciders (Jev)

Claude Code sessions ──MCP (/mcp)──► server     the Analyst, and interactive agents
```

- **Deliveries are self-contained** (server/context.ts): the event, the recipient's briefs, the
  tasks with inherited context, the recent thread, the supervisor, and subordinates. Headless agents never
  call back.
- **You come first:** `list_assignments` lists things for you first, then things from you (your
  answers also have priority 9 on RabbitMQ).
- **Status lines:** runners publish `status` to the inbox, and claims set one. They go out over SSE,
  but no screen shows them yet.
- **System One:** Ariadne asks deciders before delivering (dispatch: one difficulty score → model +
  effort). No decider, a timeout, or low confidence →
  defaults. Ariadne never calls a model itself.
- **Claims** (interactive agents; the relay skips them). One `/mcp`, with no token yet (agent-specific
  permissions come later; it is localhost only). `list_assignments` shows what's waiting (your
  items first), with the repos each item's tasks use. The session picks the first one it can
  handle and calls `claim_assignment`, which is atomic and returns the brief. Ariadne doesn't record
  who claimed. `submit_result` works in any claim state, since MCP is asynchronous and the result
  may come from another session; it fails only if the item is missing or already completed. `done`
  completes it; `blocked`, `question`, and `progress` keep it open. Any report that closes an
  assignment ends its claim. For an item for you, the brief tells the session to ask or tell you,
  and your answer is the `submit_result` body. `still_working` resets the claim timer (re-claiming
  an expired one). `release_assignment` puts it back. There is no model/effort dispatch: the session
  already runs on whatever the person chose.
- **Timers** (`timers` table): something Ariadne does at a time, with a `kind`, a `payload`, and an
  optional `key` (one live timer per key, so a timer can be reset or cancelled). A scheduler in the
  server fires due ones every 15s, RabbitMQ or not. Kinds:
  - `claim_check`: a claim with no word for `ARIADNE_CLAIM_TIMEOUT_MINUTES` goes back in the queue,
    and you get a note (not when the stuck item was itself for you);
  - `send`: an event sent later (`schedule_event`, `cancel_scheduled`, `list_scheduled` over MCP).
- **Overdue:** an assignment with `dueAt` gets one "no report yet" report from Ariadne to its sender
  (checked by the same scheduler).
- **Undo:** `history` (grouped by changeset, filterable by the event a change was made `because`
  of) and `undo` over MCP. An undo is refused if something changed again since.

## 6. Screens

- **Graph** (the only screen): all nodes and edges with filters (kinds, hide closed) and **focus**: pick a node to see
  what's reachable from it (down / up / both, with a depth). A side panel creates, edits, and deletes
  nodes, edges, and events.
- **Focus:** the focus task in the top bar is remembered across reloads.
