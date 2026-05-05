# Issue tracker: bd (beads)

Issues and PRDs for this repo live in [bd / beads](https://github.com/gastownhall/beads), a local-first dependency-graph issue tracker. Use the `bd` CLI for all operations.

bd stores its state under `.beads/` at the repo root (a Dolt-backed database). Commit `.beads/` to git so teammates and AFK agents working in worktrees see the same issues; bd ships a pre-commit hook that stages database changes — install it with `bd hooks install` if it isn't already.

## Required labels

bd labels are created automatically the first time they're applied — there is no upfront create-labels step. If a label string in `docs/agents/triage-labels.md` doesn't exist yet, the first `bd label add` that uses it will create it.

If the user has overridden the canonical role → label string mapping in `docs/agents/triage-labels.md`, use those strings instead.

## Conventions

- **Create an issue**: `bd create "Title" --description -` with the body piped or heredoc'd into stdin. Pass `-t {task,bug,feature,…}` to set the type and `-p N` for priority. Put the entire body — problem statement, design notes, acceptance criteria — in `--description` as one markdown blob (see "Single-blob description" below).
- **Read an issue**: `bd show <id> --json`. The `<id>` is bd's hierarchical ID (e.g. `bd-a3f8`, or `bd-a3f8.1` for a sub-task).
- **List issues**: `bd list --status open --json` with appropriate `--label` filters. Use `bd ready --json` instead when you only want unblocked tickets (those whose dependencies are all closed).
- **Comment on a ticket**: `bd comment add <id> --body "..."`. Use a heredoc for multi-line bodies.
- **Apply / remove labels**: `bd label add <id> <label>` / `bd label remove <id> <label>`. Labels are auto-created on first apply.
- **Close**: `bd close <id> --reason "..."`. The reason becomes a closing comment in bd's history.
- **Atomic in-progress claim**: `bd update <id> --claim` sets the assignee to the current user *and* moves status to `in_progress` in one step. Use this in agent loops to avoid the race where two iterations grab the same ticket.

## Single-blob description

bd's `bd create` accepts `--description` plus structured fields (`--design`, `--acceptance`). **Consumer skills use `--description` only** and put the entire body — problem statement, design notes, acceptance criteria — into that one markdown blob. Don't "improve" this by splitting fields: the verb facade depends on PRDs and issues being a single readable document, and the structured fields are a manual-use affordance for users who want them after creation.

## When a skill says "publish to the issue tracker"

Run `bd create` with the title and a heredoc'd `--description` body. Set `-t` to the appropriate type (`task` for most issues, `bug` for bugs, `feature` for features, etc.) and `-p N` if a priority is implied. Use `--description -` so the body comes from stdin — that avoids quoting issues with multi-line markdown.

```bash
bd create "Title goes here" -t task --description - <<'EOF'
... full body as one markdown blob ...
EOF
```

## When a skill says "fetch the relevant ticket"

Run `bd show <id> --json`.

## When a skill says "apply the `<role>` triage label"

Look up the actual label string in `docs/agents/triage-labels.md` for that canonical role, then `bd label add <id> "<actual-string>"`. bd auto-creates the label if it doesn't exist yet, so there's no separate "create label" step to gate on.

## Manual-use affordances (not part of the verb contract)

bd has features that go beyond the stable-verb facade. Skills do not call these — they're documented here for users who want to invoke them by hand:

- **Dependency edges**: `bd dep add <child> <parent>` records that `<child>` is blocked by `<parent>`. `bd ready --json` then surfaces only the tickets whose blockers are all closed.
- **Hierarchical IDs**: bd assigns IDs like `bd-a3f8` for top-level tickets; sub-tasks get suffixed IDs like `bd-a3f8.1`, `bd-a3f8.2`. Useful for breaking a ticket into smaller pieces while preserving the parent relationship in the ID itself.
- **Structured description fields**: `bd create` accepts `--design` and `--acceptance` separately from `--description`. Consumer skills don't use these (see "Single-blob description" above), but users editing a ticket later can populate them.
- **`bd ready`**: returns only unblocked tickets. The AFK loop uses this to pick up the next actionable ticket without picking one whose blockers are still open.
