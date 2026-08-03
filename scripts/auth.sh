#!/usr/bin/env bash
set -euo pipefail

config_dir="${AGENTBAY_DEMO_CONFIG_DIR:-$HOME/.config/agentbay-ink-demo}"
agentbay_key_file="${AGENTBAY_API_KEY_FILE:-$HOME/.config/agentbay/api_key}"
proxy_dir="${CLAUDEX_CONFIG_DIR:-$HOME/.config/claudex}"

read_file() {
  [[ -s "$1" ]] && IFS= read -r REPLY < "$1" || REPLY=""
  printf '%s' "$REPLY"
}

write_file() {
  local path="$1" value="$2" directory temporary
  directory="$(dirname "$path")"
  install -d -m 700 "$directory"
  temporary="$(mktemp "$directory/.auth.XXXXXX")"
  chmod 600 "$temporary"
  printf '%s\n' "$value" > "$temporary"
  mv -f "$temporary" "$path"
}

prompt() {
  local label="$1" current="${2:-}" value
  printf '%s%s: ' "$label" "$([[ -n "$current" ]] && printf '（Enter 保留现有）')" >&2
  IFS= read -r value || exit 2
  printf '%s' "${value:-$current}"
}

prompt_secret() {
  local label="$1" current="${2:-}" value
  printf '%s%s: ' "$label" "$([[ -n "$current" ]] && printf '（Enter 保留现有）')" >&2
  IFS= read -r -s value || exit 2
  [[ -t 0 ]] && printf '\n' >&2
  printf '%s' "${value:-$current}"
}

valid_url() {
  node -e 'const u=new URL(process.argv[1]);if(!["http:","https:"].includes(u.protocol)||u.username||u.password)process.exit(1)' "$1" >/dev/null 2>&1
}

login() {
  local base_url auth_kind llm_credential agentbay_key region profile
  base_url="$(prompt 'LLM Base URL' "${LLM_BASE_URL:-${ANTHROPIC_BASE_URL:-$(read_file "$config_dir/llm_base_url")}}")"
  auth_kind="$(prompt 'LLM 凭据类型 token/api-key' "${LLM_AUTH_KIND:-$(read_file "$config_dir/llm_auth_kind")}")"
  auth_kind="${auth_kind:-token}"
  llm_credential="$(prompt_secret 'LLM API key/token' "${LLM_API_KEY:-${ANTHROPIC_API_KEY:-${ANTHROPIC_AUTH_TOKEN:-$(read_file "$config_dir/llm_credential")}}}")"
  agentbay_key="$(prompt_secret 'AgentBay API key' "${AGENTBAY_API_KEY:-$(read_file "$agentbay_key_file")}")"
  region="$(prompt 'AgentBay region' "${AGENTBAY_REGION_ID:-$(read_file "$config_dir/agentbay_region_id")}")"
  region="${region:-cn-hangzhou}"
  profile="$(prompt 'Aliyun CLI profile（可留空）' "${ALIYUN_PROFILE:-$(read_file "$config_dir/aliyun_profile")}")"

  valid_url "$base_url" || { echo 'LLM Base URL 必须是无内嵌账号密码的 http/https URL' >&2; exit 2; }
  [[ "$auth_kind" == "token" || "$auth_kind" == "api-key" ]] || { echo 'LLM 凭据类型必须是 token 或 api-key' >&2; exit 2; }
  [[ -n "$llm_credential" && "$llm_credential" != *[[:space:]]* ]] || { echo 'LLM 凭据不能为空或包含空白字符' >&2; exit 2; }
  [[ "$agentbay_key" =~ ^akm?-[A-Za-z0-9_-]{8,}$ ]] || { echo 'AgentBay API key 格式无效' >&2; exit 2; }
  [[ "$region" =~ ^(cn-hangzhou|ap-southeast-1|us-east-1)$ ]] || { echo 'AgentBay region 仅支持 cn-hangzhou、ap-southeast-1、us-east-1' >&2; exit 2; }
  [[ -z "$profile" || "$profile" =~ ^[A-Za-z0-9._-]{1,128}$ ]] || { echo 'Aliyun profile 格式无效' >&2; exit 2; }

  umask 077
  write_file "$config_dir/llm_base_url" "$base_url"
  write_file "$config_dir/llm_auth_kind" "$auth_kind"
  write_file "$config_dir/llm_credential" "$llm_credential"
  write_file "$config_dir/agentbay_region_id" "$region"
  if [[ -n "$profile" ]]; then write_file "$config_dir/aliyun_profile" "$profile"; else rm -f "$config_dir/aliyun_profile"; fi
  write_file "$agentbay_key_file" "$agentbay_key"
  echo "LOGIN_PASS llm=configured agentbay=configured region=configured aliyun_profile=$([[ -n "$profile" ]] && echo configured || echo optional)"
}

status() {
  local llm_source=missing agentbay_source=missing
  if [[ -n "${ANTHROPIC_API_KEY:-}${ANTHROPIC_AUTH_TOKEN:-}" ]]; then
    llm_source=environment
  elif [[ -n "${LLM_BASE_URL:-}" && -n "${LLM_API_KEY:-}" ]]; then
    llm_source=environment
  elif [[ -s "$config_dir/llm_base_url" && -s "$config_dir/llm_auth_kind" && -s "$config_dir/llm_credential" ]]; then
    llm_source=file
  elif [[ -x "$proxy_dir/proxy-start.sh" && -x "$proxy_dir/agent-api-key-helper" ]]; then
    llm_source=claudex
  fi
  if [[ -n "${AGENTBAY_API_KEY:-}" ]]; then agentbay_source=environment; elif [[ -s "$agentbay_key_file" ]]; then agentbay_source=file; fi
  echo "AUTH_STATUS llm=$([[ "$llm_source" == missing ]] && echo missing || echo configured) agentbay=$([[ "$agentbay_source" == missing ]] && echo missing || echo configured)"
  echo "AUTH_SOURCES llm=$llm_source agentbay=$agentbay_source region=$([[ -n "${AGENTBAY_REGION_ID:-}" || -s "$config_dir/agentbay_region_id" ]] && echo configured || echo default) aliyun_profile=$([[ -n "${ALIYUN_PROFILE:-}" || -s "$config_dir/aliyun_profile" ]] && echo configured || echo optional)"
  [[ "$llm_source" != missing && "$agentbay_source" != missing ]]
}

case "${1:-login}" in
  login) login ;;
  status) status ;;
  *) echo "用法：$0 login|status" >&2; exit 2 ;;
esac
