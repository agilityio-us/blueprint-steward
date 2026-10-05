#!/bin/sh
# Clone (once, into the /work volume) the repository Steward serves, install it with its own package manager, then run
# the Steward baked into the image: `blueprint-steward <args> --server $BLUEPRINT_SERVER --repo <clone>`.
# BLUEPRINT_REPO_URL should be an https URL: the server keys a repository by its normalized remote URL, so an ssh host
# alias (git@github.com-work:...) names a different repository from the one your tracker board does.
set -eu
: "${BLUEPRINT_SERVER:?set BLUEPRINT_SERVER, e.g. https://blueprint.example.com}"
: "${BLUEPRINT_REPO_URL:?set BLUEPRINT_REPO_URL, e.g. https://github.com/your-org/your-repo.git}"
: "${GH_TOKEN:?set GH_TOKEN: git fetch and push, and gh pr create, run with it}"
REPO="/work/$(basename "$BLUEPRINT_REPO_URL" .git)"

# BLUEPRINT_STEWARD_REF was BLUEPRINT_RUNNER_REF; the old name is still read (Steward reads its others in lib/env.mjs).
REF="${BLUEPRINT_STEWARD_REF:-}"
if [ -z "$REF" ] && [ -n "${BLUEPRINT_RUNNER_REF:-}" ]; then
  echo 'steward-entrypoint: BLUEPRINT_RUNNER_REF is deprecated; set BLUEPRINT_STEWARD_REF instead' >&2
  REF="$BLUEPRINT_RUNNER_REF"
fi

gh auth setup-git
git config --global user.name "${GIT_AUTHOR_NAME:-Blueprint Steward}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-steward@blueprint.local}"

if [ ! -d "$REPO/.git" ]; then
  git clone "$BLUEPRINT_REPO_URL" "$REPO"
fi
git -C "$REPO" fetch --quiet origin
git -C "$REPO" remote set-head origin --auto >/dev/null
# The checkout Steward runs from, on REF or else the remote's default branch; job worktrees are separate
# (<repo>.blueprint-worktrees/<session>).
if [ -z "$REF" ]; then
  REF="$(git -C "$REPO" symbolic-ref --short refs/remotes/origin/HEAD | sed 's#^origin/##')"
fi
git -C "$REPO" checkout --quiet -B "$REF" "origin/$REF"
# The clone's install warms the package manager's cache, so each session worktree's own install is quick.
if [ -f "$REPO/pnpm-lock.yaml" ]; then
  ( cd "$REPO" && pnpm install --frozen-lockfile --ignore-scripts )
elif [ -f "$REPO/yarn.lock" ]; then
  ( cd "$REPO" && yarn install --immutable )
fi

exec node /opt/blueprint-steward/bin/blueprint-steward.mjs "$@" --server "$BLUEPRINT_SERVER" --repo "$REPO"
