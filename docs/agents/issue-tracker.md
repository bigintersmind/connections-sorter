# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Required labels

The skills assume these labels already exist on the repo. If any are missing when a skill tries to apply them, surface the gap to the user — don't silently create them. To create the full set up front:

```bash
for label in prd bug enhancement needs-triage needs-info ready-for-agent ready-for-human wontfix; do
  gh label create "$label" 2>/dev/null || true
done
```

If the user has overridden the canonical role → label string mapping in `docs/agents/triage-labels.md`, use those strings instead.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`. Use `--json` for machine-readable output.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on a ticket**: `gh issue comment <number> --body "..."`.
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`.
- **Close**: `gh issue close <number> --comment "..."`.

Infer the repo from `git remote -v` – `gh` does this automatically when run inside a clone.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## When a skill says "apply the `<role>` triage label"

Look up the actual label string in `docs/agents/triage-labels.md` for that canonical role, then `gh issue edit <number> --add-label "<actual-string>"`. If the configured label doesn't exist on the repo, surface the discrepancy to the user before applying – don't silently create labels.

## History: bd (beads) before 2026-08-30

Until 2026-08-30 this repo tracked work in [bd / beads](https://github.com/gastownhall/beads), a local-first tracker whose state lived under `.beads/`. Commit messages prefixed `connections-xxx:` (e.g. `connections-b8i`) refer to those bd ticket IDs, not GitHub issue numbers.

The bd archive is preserved in git history — `bdac894` is the last commit that carried `.beads/`:

```bash
# list every bd ticket
git show bdac894:.beads/issues.jsonl | jq -r 'select(._type=="issue") | "\(.id) \(.status) :: \(.title)"'
# read one in full
git show bdac894:.beads/issues.jsonl | jq 'select(.id=="connections-b8i")'
```

The three tickets still open at the switch were re-created as GitHub issues #6, #7, and #8, each with its bd ID noted at the top of the body. Closed bd tickets were not re-created.
