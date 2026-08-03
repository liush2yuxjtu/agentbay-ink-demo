#!/usr/bin/env bash
set -euo pipefail

proxy_dir="${CLAUDEX_CONFIG_DIR:-$HOME/.config/claudex}"
[[ -x "$proxy_dir/proxy-start.sh" && -x "$proxy_dir/agent-api-key-helper" ]] || {
  echo "缺少 CLIProxyAPI helper：$proxy_dir" >&2
  exit 1
}

"$proxy_dir/proxy-start.sh"
export ANTHROPIC_BASE_URL="http://127.0.0.1:8318"
export ANTHROPIC_AUTH_TOKEN="$("$proxy_dir/agent-api-key-helper")"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export NO_PROXY="127.0.0.1,localhost,::1${NO_PROXY:+,$NO_PROXY}"
export no_proxy="$NO_PROXY"
unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN

agentbay_key_file="${AGENTBAY_API_KEY_FILE:-$HOME/.config/agentbay/api_key}"
if [[ -z "${AGENTBAY_API_KEY:-}" && -s "$agentbay_key_file" ]]; then
  export AGENTBAY_API_KEY="$(<"$agentbay_key_file")"
fi

exec "$@"
