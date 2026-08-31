#!/bin/bash
set -eo pipefail

if [ -z "$1" ]; then
  echo "Usage: $0 <iterations>"
  exit 1
fi

# Run inside a persistent worktree on the `ralph` branch so the main checkout
# stays untouched while the loop commits. Created on first run, reused after.
REPO_ROOT=$(git rev-parse --show-toplevel)
WORKTREE_PATH="${REPO_ROOT}-afk"
BRANCH="ralph"
BASE_BRANCH="main"

if [ ! -d "$WORKTREE_PATH" ]; then
  if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$BRANCH"; then
    git -C "$REPO_ROOT" worktree add "$WORKTREE_PATH" "$BRANCH"
  else
    git -C "$REPO_ROOT" worktree add -b "$BRANCH" "$WORKTREE_PATH"
  fi
fi

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
  issues=$(gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]' 2>/dev/null || echo "No issues found")
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

# Wrap up: push the branch and open/update a PR if there are new commits.
COMMITS_AHEAD=$(git rev-list --count "${BASE_BRANCH}..HEAD" 2>/dev/null || echo 0)

if [ "$COMMITS_AHEAD" -eq 0 ]; then
  echo "No new commits on $BRANCH; nothing to push."
  exit 0
fi

echo "Pushing $BRANCH ($COMMITS_AHEAD commits ahead of $BASE_BRANCH)..."
git push -u origin "$BRANCH"

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
