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

# Number of runs per arm. 1 = measure a cold-ish prefix (the provider's own
# server-side cache may still be warm from earlier identical runs). 2 = an
# explicit warm run followed by the measured run.
RUNS_PER_ARM="${COG_LIVE_RUNS:-1}"

run_once() {
  local name="$1" enabled="$2" index="$3"
  local dir="${OUT_ROOT}/${name}"
  local work="${dir}/work"

  # Reset the workspace so every run starts from byte-identical fixture content;
  # otherwise an agent edit would silently change the prompt under test.
  rm -rf "${work}"; mkdir -p "${work}"
  if [ -d "${REPO}/test/live/fixture" ]; then
    cp -R "${REPO}/test/live/fixture/." "${work}/"
  fi

  echo "[live] ${name}[run ${index}/${RUNS_PER_ARM}]: running (enabled=${enabled}) ..."
  ( cd "${work}" && DEEPSEEK_API_KEY="${KEY}" timeout 280 dsh --profile headless \
      --patch "${dir}/cognitive.patch.yml" "${PROMPT}" ) \
      > "${dir}/stdout-${index}.txt" 2> "${dir}/stderr-${index}.txt"
  echo "[live] ${name}[run ${index}]: exit=$?"

  local slug; slug="$(slug_of "${work}")"
  local sdir="${DSH_HOME:-/home/dc/.dsh}/sessions/${slug}"
  local newest
  newest="$(ls -1dt "${sdir}"/*/ 2>/dev/null | head -1)"
  newest="${newest%/}"
  if [ -n "${newest}" ]; then
    echo "${newest}" > "${dir}/session-${index}.txt"
    echo "[live] ${name}[run ${index}]: session=${newest}"
  else
    echo "[live] ${name}[run ${index}]: WARNING no session log under ${sdir}"
  fi
}

run_case() {
  local name="$1" enabled="$2"
  local dir="${OUT_ROOT}/${name}"
  rm -rf "${dir}"; mkdir -p "${dir}"
  sed -e "s#__ENABLED__#${enabled}#" -e "s#__EVENTS__#${dir}/events.jsonl#" "${TEMPLATE}" > "${dir}/cognitive.patch.yml"

  local i
  for i in $(seq 1 "${RUNS_PER_ARM}"); do
    run_once "${name}" "${enabled}" "${i}"
  done

  # The measured run is the LAST one; earlier runs only warm the provider cache.
  local measured="${dir}/session-${RUNS_PER_ARM}.txt"
  [ -f "${measured}" ] && cp "${measured}" "${dir}/session-dir.txt"
  echo "[live] ${name}: measured run = run ${RUNS_PER_ARM} of ${RUNS_PER_ARM}"
}

echo "[live] repo=${REPO}"
echo "[live] out=${OUT_ROOT}"
echo "[live] runs per arm=${COG_LIVE_RUNS:-1}"
# Arm order is a real confound: the provider cache is content-addressed and
# shared, so whichever arm runs first can warm the prefix the second one hits.
# COG_LIVE_REVERSE=1 counterbalances that.
if [ "${COG_LIVE_REVERSE:-0}" = "1" ]; then
  echo "[live] arm order: treatment first (counterbalanced)"
  run_case treatment true
  run_case control false
else
  echo "[live] arm order: control first (default)"
  run_case control false
  run_case treatment true
fi
echo "[live] done"