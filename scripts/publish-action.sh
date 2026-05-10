#!/usr/bin/env bash
#
# Publish packages/action/dist/ to the dedicated action distribution
# repository under tag-based refs that GitHub Actions consumers
# reference via `uses:`.
#
# Why a separate repo? GitHub Actions consumers do
#
#     - uses: plinth/action@v1
#
# which resolves to `github.com/plinth/action` at the `v1` ref. The
# convention (per brand/decision.md §3.1) is that this is its own
# repository — not a subdirectory of the monorepo — so the consumer
# does not have to clone the entire monorepo to use the action. We
# build the bundled action in the monorepo, then push only the
# `dist/` (plus action.yml, README, and LICENSE) to the action repo.
#
# Why force-push to a moving major tag? GitHub's tag-based action
# resolution treats `v1` as a mutable reference: every patch release
# in the 1.x line moves it. This is the standard convention used by
# the official `actions/checkout`, `actions/setup-node`, etc. Users
# who want immutable resolution pin to the exact tag (`v1.4.0`) or
# the commit SHA.
#
# Inputs (env vars):
#   RELEASE_TAG    e.g. "action-v1.4.0" — the tag in the monorepo
#                  that triggered this script. The "action-" prefix
#                  is stripped to derive the action-repo tag.
#   GITHUB_TOKEN   token with `contents: write` on the action repo.
#                  In CI we use a fine-grained PAT scoped only to
#                  that repo, NOT the workflow's GITHUB_TOKEN, which
#                  cannot push to a different repository.
#
# This script is intentionally pure bash + git. No node, no jq.
# Works on the GitHub-hosted ubuntu-latest runner without extra
# tooling.

set -euo pipefail

# --- input validation ---------------------------------------------

: "${RELEASE_TAG:?RELEASE_TAG must be set (expected e.g. action-v1.4.0)}"

if [[ "${RELEASE_TAG}" != action-v* ]]; then
  echo "::error::RELEASE_TAG must start with 'action-v' (got '${RELEASE_TAG}')" >&2
  exit 1
fi

# Strip the "action-" prefix. action-v1.4.0 -> v1.4.0
EXACT_TAG="${RELEASE_TAG#action-}"

# Validate the version shape and derive the moving major tag.
if [[ ! "${EXACT_TAG}" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)(-[a-zA-Z0-9.-]+)?$ ]]; then
  echo "::error::EXACT_TAG '${EXACT_TAG}' is not v<MAJOR>.<MINOR>.<PATCH>[-pre]" >&2
  exit 1
fi
MAJOR_TAG="v${BASH_REMATCH[1]}"
PRE="${BASH_REMATCH[4]:-}"

# Pre-release tags (e.g. v1.4.0-rc.1) get the exact tag but do NOT
# move the major-version moving tag. Otherwise a release candidate
# would silently become the default for `uses: plinth/action@v1`.
PUSH_MAJOR=true
if [[ -n "${PRE}" ]]; then
  PUSH_MAJOR=false
  echo "Pre-release detected (${EXACT_TAG}); skipping major-version moving tag '${MAJOR_TAG}'."
fi

# --- locate the bundled action ------------------------------------

DIST_DIR="packages/action/dist"
ACTION_YML="packages/action/action.yml"
ACTION_README="packages/action/README.md"
LICENSE_FILE="LICENSE"

if [[ ! -d "${DIST_DIR}" ]]; then
  echo "::error::${DIST_DIR}/ does not exist. Did the build step run?" >&2
  exit 1
fi
if [[ ! -f "${DIST_DIR}/index.js" ]]; then
  echo "::error::${DIST_DIR}/index.js is missing — ncc build did not produce the expected entry." >&2
  exit 1
fi
if [[ ! -f "${ACTION_YML}" ]]; then
  echo "::error::${ACTION_YML} is missing — the Action consumer needs this at the repo root." >&2
  exit 1
fi

# --- target repo --------------------------------------------------

# Derived from brand/decision.md §3.1 ("Action namespace:
# plinth/action@v1"). When the GitHub org name resolves (the brand
# decision doc lists `plinth` as the preferred org with `plinthdev`
# as a fallback), update this value. Until then this is the
# committed default.
ACTION_REPO="${ACTION_REPO:-plinth/action}"
ACTION_REPO_URL="https://x-access-token:${GITHUB_TOKEN:?GITHUB_TOKEN is required}@github.com/${ACTION_REPO}.git"

# --- assemble the publish tree -----------------------------------

# A clean, scratch directory holds exactly what we want users to
# clone when they `uses: plinth/action@v1`. Nothing else.
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

mkdir -p "${WORK}/dist"
cp -R "${DIST_DIR}/." "${WORK}/dist/"
cp "${ACTION_YML}" "${WORK}/action.yml"
[[ -f "${ACTION_README}" ]] && cp "${ACTION_README}" "${WORK}/README.md"
[[ -f "${LICENSE_FILE}" ]] && cp "${LICENSE_FILE}" "${WORK}/LICENSE"

# A tiny header so anyone who clicks into `plinth/action` from the
# workflow snippet sees that this repo is generated and where to
# file issues / send PRs.
cat > "${WORK}/.github-source.md" <<EOF
# This repository is auto-generated.

The source for this GitHub Action lives in the Plinth monorepo at
\`packages/action/\`. Please file issues and open pull requests there:

  https://github.com/${ACTION_REPO%/action}/plinth

This repository ships only the bundled \`dist/index.js\` and
\`action.yml\` so that consumers can reference \`uses: ${ACTION_REPO}@v${MAJOR_TAG#v}\`
without cloning the full monorepo.

Built from monorepo tag: ${RELEASE_TAG}
EOF

# --- push the publish tree ---------------------------------------

cd "${WORK}"
git init -q -b main
git -c user.name="plinth-release-bot" -c user.email="release@plinth.dev" \
    commit --quiet --allow-empty -m "release ${EXACT_TAG}" --allow-empty-message || true
git add .
git -c user.name="plinth-release-bot" -c user.email="release@plinth.dev" \
    commit --quiet -m "release ${EXACT_TAG}"

# Tag the publish commit with the exact-version tag. This one is
# never overwritten — exact tags are immutable by convention.
git tag "${EXACT_TAG}"

# Force-push to the action repo. We push:
#   - The exact tag (immutable; should never collide with an
#     existing tag of the same name — if it does, that's a bug we
#     want to surface, so we DON'T pass --force on this push).
#   - The major moving tag (mutable; --force is correct here).
echo "Pushing exact tag ${EXACT_TAG} to ${ACTION_REPO}..."
git push "${ACTION_REPO_URL}" "${EXACT_TAG}"

if [[ "${PUSH_MAJOR}" == "true" ]]; then
  git tag -f "${MAJOR_TAG}"
  echo "Force-pushing major moving tag ${MAJOR_TAG} to ${ACTION_REPO}..."
  git push --force "${ACTION_REPO_URL}" "${MAJOR_TAG}"
fi

echo
echo "Action published:"
echo "  uses: ${ACTION_REPO}@${EXACT_TAG}"
if [[ "${PUSH_MAJOR}" == "true" ]]; then
  echo "  uses: ${ACTION_REPO}@${MAJOR_TAG}    (moving major tag)"
fi
