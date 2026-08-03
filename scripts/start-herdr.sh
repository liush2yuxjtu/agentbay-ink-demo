#!/usr/bin/env bash
set -euo pipefail

command -v herdr >/dev/null || { echo "未找到 herdr" >&2; exit 1; }
root="$(cd "$(dirname "$0")/.." && pwd)"
workspace=()
[[ -n "${HERDR_WORKSPACE_ID:-}" ]] && workspace=(--workspace "$HERDR_WORKSPACE_ID")
created="$(herdr tab create "${workspace[@]}" --cwd "$root" --label 'AgentBay Demo' --no-focus)"
read -r tab_id pane_id < <(printf '%s' "$created" | node -e '
  let s=""; process.stdin.on("data", d => s += d).on("end", () => {
    const r = JSON.parse(s).result;
    process.stdout.write(`${r.tab.tab_id} ${r.root_pane.pane_id}\n`);
  });
')
if ! herdr pane run "$pane_id" 'npm start'; then
  herdr tab close "$tab_id" >/dev/null 2>&1 || true
  exit 1
fi
printf 'AgentBay Demo 已在后台启动：tab=%s pane=%s\n' "$tab_id" "$pane_id"
