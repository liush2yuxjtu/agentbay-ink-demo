#!/usr/bin/env bash
set -euo pipefail

config_dir="${AGENTBAY_DEMO_CONFIG_DIR:-$HOME/.config/agentbay-ink-demo}"
proxy_dir="${CLAUDEX_CONFIG_DIR:-$HOME/.config/claudex}"
read_config() { [[ -s "$1" ]] && IFS= read -r REPLY < "$1" && printf '%s' "$REPLY"; }

if [[ -n "${LLM_BASE_URL:-}${LLM_API_KEY:-}" ]]; then
  [[ -n "${LLM_BASE_URL:-}" && -n "${LLM_API_KEY:-}" ]] || { echo "LLM_BASE_URL 与 LLM_API_KEY 必须同时设置" >&2; exit 1; }
  export ANTHROPIC_BASE_URL="$LLM_BASE_URL"
  case "${LLM_AUTH_KIND:-token}" in
    token) export ANTHROPIC_AUTH_TOKEN="$LLM_API_KEY"; unset ANTHROPIC_API_KEY ;;
    api-key) export ANTHROPIC_API_KEY="$LLM_API_KEY"; unset ANTHROPIC_AUTH_TOKEN ;;
    *) echo "LLM_AUTH_KIND 必须是 token 或 api-key" >&2; exit 1 ;;
  esac
elif [[ -n "${ANTHROPIC_API_KEY:-}${ANTHROPIC_AUTH_TOKEN:-}" ]]; then
  [[ -z "${ANTHROPIC_API_KEY:-}" || -z "${ANTHROPIC_AUTH_TOKEN:-}" ]] || { echo "ANTHROPIC_API_KEY 与 ANTHROPIC_AUTH_TOKEN 不能同时设置" >&2; exit 1; }
  export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-https://api.anthropic.com}"
elif [[ -s "$config_dir/llm_base_url" && -s "$config_dir/llm_auth_kind" && -s "$config_dir/llm_credential" ]]; then
  export ANTHROPIC_BASE_URL="$(read_config "$config_dir/llm_base_url")"
  llm_credential="$(read_config "$config_dir/llm_credential")"
  case "$(read_config "$config_dir/llm_auth_kind")" in
    token) export ANTHROPIC_AUTH_TOKEN="$llm_credential"; unset ANTHROPIC_API_KEY ;;
    api-key) export ANTHROPIC_API_KEY="$llm_credential"; unset ANTHROPIC_AUTH_TOKEN ;;
    *) echo "保存的 LLM 凭据类型无效；请重新运行 npm run login" >&2; exit 1 ;;
  esac
elif [[ -x "$proxy_dir/proxy-start.sh" && -x "$proxy_dir/agent-api-key-helper" ]]; then
  "$proxy_dir/proxy-start.sh"
  export ANTHROPIC_BASE_URL="http://127.0.0.1:8318"
  export ANTHROPIC_AUTH_TOKEN="$("$proxy_dir/agent-api-key-helper")"
  unset ANTHROPIC_API_KEY
else
  echo "缺少 LLM 登录配置；请先运行 npm run login" >&2
  exit 1
fi

export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export NO_PROXY="127.0.0.1,localhost,::1${NO_PROXY:+,$NO_PROXY}"
export no_proxy="$NO_PROXY"
unset CLAUDE_CODE_OAUTH_TOKEN LLM_API_KEY

agentbay_key_file="${AGENTBAY_API_KEY_FILE:-$HOME/.config/agentbay/api_key}"
if [[ -z "${AGENTBAY_API_KEY:-}" && -s "$agentbay_key_file" ]]; then
  export AGENTBAY_API_KEY="$(<"$agentbay_key_file")"
fi
[[ -n "${AGENTBAY_API_KEY:-}" ]] || { echo "缺少 AgentBay 登录配置；请先运行 npm run login" >&2; exit 1; }
if [[ -z "${AGENTBAY_REGION_ID:-}" && -s "$config_dir/agentbay_region_id" ]]; then
  export AGENTBAY_REGION_ID="$(read_config "$config_dir/agentbay_region_id")"
fi
if [[ -z "${ALIYUN_PROFILE:-}" && -s "$config_dir/aliyun_profile" ]]; then
  export ALIYUN_PROFILE="$(read_config "$config_dir/aliyun_profile")"
fi

exec "$@"
