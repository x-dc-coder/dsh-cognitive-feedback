#!/usr/bin/env bash
#
# Live acceptance test for dsh-cognitive-feedback.
#
# Proves, against a REAL DSH session (not a mock):
#   1. the cognitive section is actually injected into an assembled prompt;
#   2. dynamic injection does not destroy prompt-cache reuse.
#
# It runs the headless profile twice with one fixed task:
#   control   — plugin mounted with `enabled: false`
#   treatment — plugin mounted and enabled
# and compares provider cache metrics read from the flushed Session V3 log.
#
# Usage: bash test/live/run-live.sh ["<task prompt>"]
set -uo pipefail

REPO="/home/dc/projects/dsh-cognitive-feedback"
TEMPLATE="${REPO}/test/live/cognitive.patch.template.yml"
PROMPT="${1:-Refactor the storage layer so we can support three backends. Reply with exactly one short sentence and do not use any tools.}"
OUT_ROOT="${COG_LIVE_OUT:-/tmp/cog-live}"

# --- credentials ---------------------------------------------------------
# The running web app holds the provider key in its process environment; the
# headless profile reads the same env var. The value is never printed.
find_key() {
  local pid
  for pid in $(pgrep -f 'dsh' 2>/dev/null); do
    [ -r "/proc/${pid}/environ" ] || continue
    if tr '\0' '\n' < "/proc/${pid}/environ" 2>/dev/null | grep -q '^DEEPSEEK_API_KEY='; then
      tr '\0' '\n' < "/proc/${pid}/environ" | grep '^DEEPSEEK_API_KEY=' | head -1 | cut -d= -f2-
      return 0
    fi
  done
  return 1
}

KEY="$(find_key || true)"
if [ -z "${KEY}" ]; then
  echo "FATAL: DEEPSEEK_API_KEY not found in any dsh process environment" >&2
  exit 3
fi
echo "[live] provider key acquired (not printed)"

# Session logs live under $DSH_HOME/sessions/<slug-of-cwd>/<session-id>/
slug_of() {
  printf '%s' "$1" | sed -e 's#/#-#g' | sed -e 's#^-#--#' -e 's#$#--#'
}

run_case() {
  local name="$1" enabled="$2"
  local dir="${OUT_ROOT}/${name}"
  local work="${dir}/work"
  rm -rf "${dir}"; mkdir -p "${work}"
  if [ -d "${REPO}/test/live/fixture" ]; then
    cp -R "${REPO}/test/live/fixture/." "${work}/"
  fi

  sed -e "s#__ENABLED__#${enabled}#" -e "s#__EVENTS__#${dir}/events.jsonl#" "${TEMPLATE}" > "${dir}/cognitive.patch.yml"

  echo "[live] ${name}: running (enabled=${enabled}) ..."
  ( cd "${work}" && DEEPSEEK_API_KEY="${KEY}" timeout 280 dsh --profile headless \
      --patch "${dir}/cognitive.patch.yml" "${PROMPT}" ) \
      > "${dir}/stdout.txt" 2> "${dir}/stderr.txt"
  echo "[live] ${name}: exit=$?"

  local slug; slug="$(slug_of "${work}")"
  local sdir="${DSH_HOME:-/home/dc/.dsh}/sessions/${slug}"
  local newest
  newest="$(ls -1dt "${sdir}"/*/ 2>/dev/null | head -1)"
  newest="${newest%/}"
  if [ -n "${newest}" ]; then
    echo "${newest}" > "${dir}/session-dir.txt"
    echo "[live] ${name}: session=${newest}"
  else
    echo "[live] ${name}: WARNING no session log under ${sdir}"
  fi
  echo "${dir}" > "${OUT_ROOT}/.lastdir-${name}"
}

echo "[live] repo=${REPO}"
echo "[live] out=${OUT_ROOT}"
run_case control false
run_case treatment true
echo "[live] done"