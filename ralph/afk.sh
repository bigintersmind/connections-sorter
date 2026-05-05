#!/bin/bash
set -eo pipefail

if [ -z "$1" ]; then
  echo "Usage: $0 <iterations>"
  exit 1
fi

# Pre-flight: the user opted into bd by running setup-skills, so a missing bd
# binary is a setup error, not a fall-through case. Fail fast with a clear
# message rather than letting `bd hooks install` or the substituted
# `bd ready --json` fail mid-flight under set -e.
if ! command -v bd >/dev/null 2>&1; then
  echo "Error: 'bd' not found on PATH. This loop requires bd (https://github.com/gastownhall/beads)."
  echo "Install bd, or re-run /setup-skills with a different tracker."
  exit 1
fi

# Run inside a persistent worktree on the `ralph` branch so the main checkout
# stays untouched while the loop commits. Created on first run, reused after.
REPO_ROOT=$(git rev-parse --show-toplevel)
WORKTREE_PATH="${REPO_ROOT}-afk"
BRANCH="ralph"
# __BASE_BRANCH__ is replaced by setup-skills at install time with the repo's
# detected base branch (e.g. main, master).
BASE_BRANCH="main"

if [ ! -d "$WORKTREE_PATH" ]; then
  if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$BRANCH"; then
    git -C "$REPO_ROOT" worktree add "$WORKTREE_PATH" "$BRANCH"
  else
    git -C "$REPO_ROOT" worktree add -b "$BRANCH" "$WORKTREE_PATH"
  fi
fi

# Install bd's pre-commit hook in the worktree on every invocation. The hook
# stages .beads/ database changes (claim, status, close) into the regular git
# commits the loop produces — that's how bd state propagates back to the
# maintainer without a separate `bd dolt push` step. `bd hooks install`
# overwrites the hook file, so re-running each iteration is harmless and
# self-heals if the hook was ever missing.
(cd "$WORKTREE_PATH" && bd hooks install)

cd "$WORKTREE_PATH"

# jq filter to extract streaming text from assistant messages
stream_text='select(.type == "assistant").message.content[]? | select(.type == "text").text // empty | gsub("\n"; "\r\n") | . + "\r\n\n"'

# jq filter to extract final result
final_result='select(.type == "result").result // empty'

# One tmpfile, reused. Per-iteration mktemp would orphan all but the last,
# since each new trap overwrites the previous EXIT handler.
tmpfile=$(mktemp)
trap 'rm -f "$tmpfile"' EXIT

for ((i=1; i<=$1; i++)); do
  : > "$tmpfile"

  commits=$(git log -n 5 --format="%H%n%ad%n%B---" --date=short 2>/dev/null || echo "No commits found")
  # __TICKET_FETCH_CMD__ is replaced by setup-skills at install time with
  # `bd ready --json` (only unblocked tickets — those whose dependencies are
  # all closed). On an empty queue bd returns `[]` with exit 0; the prompt
  # template teaches Claude to emit <promise>NO MORE TASKS</promise> in that
  # case so the loop terminates cleanly instead of burning iterations.
  issues=$(bd ready --json 2>/dev/null || echo "No issues found")
  prompt=$(cat ralph/prompt.md)

  claude \
    --verbose \
    --print \
    --output-format stream-json \
    "Previous commits: $commits Issues: $issues $prompt" \
  | grep --line-buffered '^{' \
  | tee "$tmpfile" \
  | jq --unbuffered -rj "$stream_text"

  result=$(jq -r "$final_result" "$tmpfile")

  if [[ "$result" == *"<promise>NO MORE TASKS</promise>"* ]]; then
    echo "Ralph complete after $i iterations."
    break
  fi
done

# Wrap up: bd is the local tracker, but the host repo usually pushes to GitHub
# or GitLab. Dispatch on the origin remote's host so the code-review surface
# matches whatever the user actually has wired up.
COMMITS_AHEAD=$(git rev-list --count "${BASE_BRANCH}..HEAD" 2>/dev/null || echo 0)

if [ "$COMMITS_AHEAD" -eq 0 ]; then
  echo "No new commits on $BRANCH; nothing to push."
  exit 0
fi

REMOTE_URL=$(git remote get-url origin 2>/dev/null || echo "")

# Extract just the host from the remote URL. Matching on the full URL with
# globs like `*github.com*` lets path components false-match (e.g. a remote
# at `example.com/github.com-mirror/...` would route into the GitHub branch);
# anchoring on the host makes dispatch honest.
HOST=""
case "$REMOTE_URL" in
  git@*:*)
    HOST="${REMOTE_URL#git@}"
    HOST="${HOST%%:*}"
    ;;
  https://*|http://*)
    tmp="${REMOTE_URL#*://}"
    tmp="${tmp#*@}"
    HOST="${tmp%%/*}"
    ;;
  ssh://*)
    tmp="${REMOTE_URL#ssh://}"
    tmp="${tmp#*@}"
    HOST="${tmp%%[:/]*}"
    ;;
esac

case "$HOST" in
  github.com)
    echo "Pushing $BRANCH ($COMMITS_AHEAD commits ahead of $BASE_BRANCH)..."
    git push -u origin "$BRANCH"

    # Push succeeded; if gh isn't on PATH, exit cleanly with manual instructions
    # rather than letting the script abort under set -e with a confusing error.
    # The bd user picked bd, not GitHub — gh is only incidentally needed here.
    if ! command -v gh >/dev/null 2>&1; then
      echo "Branch pushed. 'gh' not on PATH; install it and run:"
      echo "  gh pr create --base $BASE_BRANCH --head $BRANCH"
      exit 0
    fi

    EXISTING_PR=$(gh pr list --head "$BRANCH" --state open --json number --jq '.[0].number // ""')

    if [ -n "$EXISTING_PR" ]; then
      echo "PR #$EXISTING_PR already open for $BRANCH; updated via push."
      gh pr view "$EXISTING_PR" --json url --jq '.url'
    else
      PR_BODY=$(git log "${BASE_BRANCH}..HEAD" --format="- %s" --reverse)
      gh pr create \
        --base "$BASE_BRANCH" \
        --head "$BRANCH" \
        --title "AFK loop output ($BRANCH)" \
        --body "$PR_BODY"
    fi
    ;;
  *gitlab*)
    # Wildcard on host (not strict `gitlab.com`) so self-hosted GitLab installs
    # whose host contains `gitlab` (e.g. `gitlab.example.com`, `mygitlab.io`)
    # take this branch. Host-anchored above, so a path containing `gitlab`
    # won't false-match. False positives are still possible on hostnames that
    # happen to contain `gitlab` but aren't GitLab — those will surface as a
    # clear `glab` auth/setup error rather than silent corruption.
    echo "Pushing $BRANCH ($COMMITS_AHEAD commits ahead of $BASE_BRANCH)..."
    git push -u origin "$BRANCH"

    if ! command -v glab >/dev/null 2>&1; then
      echo "Branch pushed. 'glab' not on PATH; install it and run:"
      echo "  glab mr create --target-branch $BASE_BRANCH --source-branch $BRANCH"
      exit 0
    fi

    EXISTING_MR=$(glab mr list --source-branch "$BRANCH" --state opened -F json | jq -r '.[0].iid // ""')

    if [ -n "$EXISTING_MR" ]; then
      echo "MR !$EXISTING_MR already open for $BRANCH; updated via push."
      glab mr view "$EXISTING_MR" -F json | jq -r '.web_url'
    else
      MR_DESC=$(git log "${BASE_BRANCH}..HEAD" --format="- %s" --reverse)
      glab mr create \
        --target-branch "$BASE_BRANCH" \
        --source-branch "$BRANCH" \
        --title "AFK loop output ($BRANCH)" \
        --description "$MR_DESC"
    fi
    ;;
  *)
    # No remote, or a host that's neither github.com nor *gitlab*. Leave the
    # commits in the worktree for the maintainer to merge by hand. Echo the
    # actual REMOTE_URL and extracted HOST so a confused user can diagnose
    # what we matched on rather than wondering why no PR/MR was opened.
    echo "Loop done. $COMMITS_AHEAD commits on $BRANCH (worktree: $WORKTREE_PATH)."
    if [ -n "$REMOTE_URL" ]; then
      echo "Remote 'origin' is '$REMOTE_URL' (host: '${HOST:-<unparsed>}') — not github.com or *gitlab*, so no PR/MR opened."
    else
      echo "No 'origin' remote configured; nothing to push."
    fi
    echo "To merge: cd $REPO_ROOT && git merge $BRANCH"
    ;;
esac
