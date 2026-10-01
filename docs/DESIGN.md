# Ariadne v2 design

**Summary:** Ariadne is a **graph** (tasks, people, agents, teams, resources) plus a **log of
events** (assign and report). You work in an augmented **chat timeline** with the Analyst, and
browse or edit everything in a **graph view**. Only the Analyst uses MCP. Every other agent
works only through assignments and reports on RabbitMQ.

Agreed on 2026-10-01, after using v1 for real work (v1 is on `master`).

---

## 1. What changed from v1, and why

| v1 | v2 | Why |
|---|---|---|
| Outcomes + Tasks + Dependencies + Plans + Reviews + ... (~25 tables) | **5 tables**: `nodes`, `edges`, `events`, `event_tasks`, `audit` | v1 felt like data entry or a bug tracker |
| Outcome | A **root task**: a task that no task `needs` | One concept instead of two |
| Subtask *and* prerequisite | One edge kind: **A `needs` B** | Breaking work down and blocking on something are the same thing |
| Pages and forms | **Chat timeline** + **graph view** | Interactive, not data entry |
| Agents call MCP | **Only the Analyst** has MCP | Agents are decoupled; all changes go through one place |

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
| You type in the chat | An assign event to the Analyst (about the focus task, if one is set) |
| The Analyst answers | A report |
| A card | An assign event to you, with `card` (title, fields, buttons) |
| You press a button | Your report, with `response` |
| Work for another person or team | A **proxy card** for you ("Ask Bryan"). Your answer becomes *their* report |
| An agent's result | A report over the inbox. It can carry `proposals` (ops) that the Analyst applies or escalates |
| A System One question | An assign event to a decider agent, with `questions`; the answer is a report with `answers` |

**Who may assign to whom:** you assign only to the Analyst. The Analyst and Ariadne may assign to
anyone. Other agents may assign only to their direct subordinates (and to deciders).

**Delivery:** an event to an agent is `pending` until the relay publishes it, then `delivered`. It is
`held` while Ariadne waits for a System One decision, and `none` for everyone else.

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
          runners: analyst (claude -p + Ariadne MCP), agents (claude -p, no Ariadne MCP), deciders (Jev)
```

- **Deliveries are self-contained** (server/context.ts): the event, the recipient's briefs, the
  tasks with inherited context, the recent thread, the supervisor, and subordinates. Agents never
  call back.
- **Your messages jump the queue:** they have priority 9; agent reports have 1.
- **Status lines:** runners publish `status` to the inbox, and the Analyst can call `set_status`.
  Browsers see them live over SSE.
- **System One:** Ariadne asks deciders before delivering (chat triage: intent + what it's about;
  dispatch: one difficulty score → model + effort). No decider, a timeout, or low confidence →
  defaults. Ariadne never calls a model itself.
- **Overdue:** an assignment with `dueAt` gets one "no report yet" report from Ariadne to its sender.
- **Undo:** each timeline item shows what the Analyst changed while handling it, with an Undo button.
  An undo is refused if something changed again since.

## 6. Screens

- **Timeline:** your messages, the Analyst's replies, and cards. Open cards are shown in full;
  closed ones shrink to one line. Status line, Undo chips, triage chips.
- **Graph:** all nodes and edges with filters (kinds, hide closed) and **focus**: pick a node to see
  what's reachable from it (down / up / both, with a depth). A side panel creates, edits, and deletes
  nodes, edges, and events.
- **Shared focus:** the same focus task filters the timeline to events about it or anything it needs.
