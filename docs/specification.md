# Specification v1

The contract between Blueprint, through Steward, and the agent that delivers a designed work item.
It names only what crosses the boundary: how an agent delivers is its own. The constants and types
live in `@bett3r-dev/blueprint-spec`.

## Principles

1. Steward holds the keys and makes every write outside the item's branches: the tracker, the pull
   request, the merge. The agent writes only commits on its own branch.
2. Everything the agent says is a git trailer; everything Blueprint tells the agent is the fire or a
   commit on the item's branch.
3. A harness's internals never cross. A harness may add trailers in its own namespace; Steward
   ignores them.

## 1. The fire

Steward fires the agent's routine for the item. The fire's text is one JSON object:

```json
{
  "specification": 1,
  "key": "PROJ-1",
  "title": "Reserve stock on checkout",
  "branch": "PROJ-1-reserve-stock-on-checkout",
  "agentBranch": "claude/PROJ-1-reserve-stock-on-checkout",
  "pullRequest": "https://github.com/your-org/your-repo/pull/12",
  "design": "docs/prs/PROJ-1/blueprint.md",
  "signal": "Blueprint-Status",
  "answer": null,
  "options": {}
}
```

| Field | Meaning |
| - | - |
| `specification` | This document's version, `1`. |
| `key`, `title` | The work item. |
| `branch` | B, the item's branch. |
| `agentBranch` | F, the only branch the agent pushes to: `claude/` and B. |
| `pullRequest` | B's pull request, or `null` when none is recorded. |
| `design` | The design's path on B. |
| `signal` | The trailer key the agent signals under. |
| `answer` | The person's reply to the last `needs-human`, or `null`. |
| `options` | Set per agent in Blueprint's settings and passed through untouched; the harness reads it. |

## 2. Branches

- B, `<KEY>-<slug>`, is created by Steward with a draft pull request to the default branch.
- F, `claude/<B>`: the agent cuts it from B's tip if absent, otherwise continues it, merging B's tip
  in when B has moved. It pushes only to F.

## 3. The design

`<docsRoot>/<KEY>/blueprint.md` is the design to deliver. Beside it, `<docsRoot>/<KEY>/blueprint/`
holds the session's bundle. `docsRoot` comes from `.blueprint.config.json`, default `docs/prs`; the
fire carries the resolved path. Steward commits the design with the trailers `Blueprint-Session`,
`Blueprint-Seq` and `Blueprint-Actors`.

### Grammar of `blueprint.md`

Below, `<em dash>` stands for U+2014 and `→` is U+2192, as the renderer writes them. `<id>` is one or
more characters, none a space or a backtick. `<type>` is lowercase letters, digits and hyphens,
starting with a letter, never `node` or `edge`. A line is read with its trailing spaces dropped.

**Front matter.** The file opens with `---`, `name: value` lines, then `---`. It holds `key: <KEY>`;
other fields are free. A design whose `key` is not the fire's is not this item's.

**Sections.** A section runs from its `## <heading>` line to the next `## ` line. `## Scenarios` and
`## Artifacts` are normative and both present; every other section is prose for people. An item is a
line at the margin starting `- `, with the lines indented under it; `_None._` says the section is
empty; blank lines are nothing.

**`## Scenarios`**, the acceptance criteria, at least one:

    - <id> <em dash> <title> (<note>)
      - Given <text>
      - And <text>
      - When <text>
      - Then <text>
      - And <text>

- `<id>` is stable across renders and unique in the design, so plans, verdicts and rejections can
  cite it. A walk a decided fork proposes is `derived:<fork>/<option>/<walk>`, the walk
  percent-encoded.
- `<title>` and `<note>` are for people.
- Steps are indented two spaces or more, one per line: one `Given`, one `When`, one `Then`, in that
  order, each followed by any number of `And`. A scenario with no steps fails the design.

**`## Artifacts`**, the event model, each item one of:

| Line | Means |
| - | - |
| ``- <type> <label> in <subdomain> (`<id>`)[, serves ...]`` | a node proposed |
| ``- edge `<from>` → `<to>` (<kind>[; handlers ...])`` | an edge proposed |
| ``- modifies <type> `<id>`[ → `<new id>`][, serves ...]`` | a node modified; with a new id, renamed |
| ``- removes <type> `<id>` `` | a node removed |
| ``- removes edge `<from>` → `<to>` (<kind>)`` | an edge removed |

Lines indented under an item are details for people. Ids are code identity, as the repository's
extractor writes them. Any other item under either section fails the design, citing its line.

## 4. The scaffold

- After the design, Steward makes one commit, `chore(<KEY>): scaffold the agreed design`, with the
  trailer `Blueprint-Scaffold: <KEY>` and `<docsRoot>/<KEY>/scaffold.json` in the same commit. The
  report's `status` is `done`, `blocked` or `skipped`; a skipped scaffold's commit holds only the
  report.
- The latest scaffold commit on B is the one in force: a redesign lands a new one.
- Gaps are lines marked `TODO(scaffold)`. Every other line the scaffold added is the design's, and
  the agent keeps it.

## 5. Configuration

`.blueprint.config.json` holds Blueprint's adapters: `designTooling.extract`,
`designTooling.scaffold`, `docsRoot` and the existing fields. A harness keeps its settings in a file
of its own.

`designTooling.typeWords`, optional, names the word a node type's code names end in, by type:
`{ "aggregate": "Aggregate", "policy": "Policy" }`. A design may label a node without it, so a
proposed node is also realized by its code id: its label without the word it may end in, in
PascalCase, with the word appended once, slugified into the id in place of the label's slug. The
repository's extractor writes the same words onto the graph it pushes, as `typeWords`, and Blueprint
and the agent both match a proposed node, and every edge naming it, by its own id or its code id.
Without the field, only a node's own id realizes it.

## 6. The signal

On F, a trailer under the fire's `signal` key, on any commit. Steward reads F's new commits on each
poll; the latest value is the state.

| Value | Means | Blueprint does |
| - | - | - |
| `working` | a heartbeat | clears the item's "stuck" mark |
| `done` | delivered | merges F into B, sets the pull request's body from `<docsRoot>/<KEY>/pull-request.md` if committed, readies it, moves the item to success |
| `needs-human` | an answer is needed; the commit's subject asks it | moves the item to needs-human and comments the subject |
| `rejected` | the design or scaffold cannot be delivered as given; the body says why | moves the item to needs-human and comments the body |
| `failed` | the agent could not run | moves the item to needs-human and comments the body |

An unknown value is recorded and ignored. A person answers a `needs-human` with a tracker comment
and moves the item back to the implementation column; Steward fires again with that comment as
`answer`. A merge of F into B that conflicts is reported as `needs-human`.

## 7. Completion

- One pull request per item, B to the default branch, opened by Steward with B.
- The agent writes the description as `<docsRoot>/<KEY>/pull-request.md`, exhibits linked by
  commit; Steward posts it on `done`.
- The agent keeps its own state under `<docsRoot>/<KEY>/`. What of that directory reaches the
  default branch is the repository's policy.
