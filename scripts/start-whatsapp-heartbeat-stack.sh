#!/usr/bin/env bash
set -euo pipefail

usage() {
  local code="${1:-1}"
  printf 'Usage: %s [--hostname HOST] [--port PORT] [--model PROVIDER/MODEL] [--agent AGENT] [--prompt PROMPT] [--runtime-dir DIR] [--whatsapp-bin PATH] [--request-kinds JSON]\n' "${0##*/}" >&2
  exit "$code"
}

hostname="127.0.0.1"
port="4096"
model="openai/gpt-5.4"
agent="build"
prompt="RC_HEARTBEAT"
runtime_dir="${RUNTIME_DIR:-${TMPDIR:-/tmp}/opencode-imsg-connector}"
request_kinds=""

opencode_bin="${OPENCODE_BIN:-opencode}"
node_bin="${NODE_BIN:-node}"
whatsapp_bin="${WHATSAPP_BIN:-wu}"
whatsapp_bin_real="${WHATSAPP_REAL_BIN:-$whatsapp_bin}"
curl_bin="${CURL_BIN:-curl}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hostname)
      [[ $# -ge 2 ]] || usage
      hostname="$2"
      shift 2
      ;;
    --port)
      [[ $# -ge 2 ]] || usage
      port="$2"
      shift 2
      ;;
    --model)
      [[ $# -ge 2 ]] || usage
      model="$2"
      shift 2
      ;;
    --agent)
      [[ $# -ge 2 ]] || usage
      agent="$2"
      shift 2
      ;;
    --prompt)
      [[ $# -ge 2 ]] || usage
      prompt="$2"
      shift 2
      ;;
    --runtime-dir)
      [[ $# -ge 2 ]] || usage
      runtime_dir="$2"
      shift 2
      ;;
    --whatsapp-bin)
      [[ $# -ge 2 ]] || usage
      whatsapp_bin="$2"
      shift 2
      ;;
    --request-kinds)
      [[ $# -ge 2 ]] || usage
      request_kinds="$2"
      shift 2
      ;;
    -h|--help)
      usage 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage
      ;;
  esac
done

server_url="http://${hostname}:${port}"
script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
whatsapp_cli_wrapper="${script_dir}/whatsapp-cli.js"
watcher_script="${script_dir}/watch-whatsapp-heartbeat.js"

server_pid_file="${runtime_dir}/opencode-server.pid"
watcher_pid_file="${runtime_dir}/whatsapp-heartbeat-watcher.pid"
server_log_file="${runtime_dir}/opencode-server.log"
watcher_log_file="${runtime_dir}/whatsapp-heartbeat-watcher.log"

required_bins=("$opencode_bin" "$node_bin" "$curl_bin")

if [[ -n "${WHATSAPP_REAL_BIN+x}" ]]; then
  required_bins+=("$whatsapp_bin")
  if [[ "$whatsapp_bin" == "$whatsapp_cli_wrapper" ]]; then
    whatsapp_bin="whatsapp-cli"
  fi
else
  if [[ -n "${WHATSAPP_BIN+x}" ]]; then
    required_bins+=("$whatsapp_bin")
  else
    required_bins+=("$whatsapp_cli_wrapper" "$whatsapp_bin")
  fi
fi

for required_bin in "${required_bins[@]}"; do
  if ! command -v "$required_bin" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$required_bin" >&2
    exit 1
  fi
done

mkdir -p "$runtime_dir"

read_pid_file() {
  local file_path="$1"

  if [[ ! -f "$file_path" ]]; then
    return 1
  fi

  local pid
  pid="$(<"$file_path")"

  if [[ -z "$pid" ]]; then
    return 1
  fi

  if kill -0 "$pid" >/dev/null 2>&1; then
    printf '%s\n' "$pid"
    return 0
  fi

  return 1
}

server_is_healthy() {
  "$curl_bin" -fsS "${server_url}/global/health" >/dev/null 2>&1
}

wait_for_server() {
  local attempts=50

  while (( attempts > 0 )); do
    if server_is_healthy; then
      return 0
    fi

    sleep 0.2
    attempts=$((attempts - 1))
  done

  return 1
}

server_status="reused"
watcher_status="reused"
server_pid=""
watcher_pid=""

if server_is_healthy; then
  if server_pid="$(read_pid_file "$server_pid_file" 2>/dev/null)"; then
    server_status="already running"
  else
    server_status="already running (external)"
  fi
else
  nohup env OPENCODE_CLIENT=cli "$opencode_bin" serve --hostname "$hostname" --port "$port" >"$server_log_file" 2>&1 &
  server_pid="$!"
  printf '%s\n' "$server_pid" >"$server_pid_file"
  server_status="started"

  if ! wait_for_server; then
    printf 'OpenCode server failed to become healthy at %s\n' "$server_url" >&2
    printf 'Server log: %s\n' "$server_log_file" >&2
    exit 1
  fi
fi

if watcher_pid="$(read_pid_file "$watcher_pid_file" 2>/dev/null)"; then
  watcher_status="already running"
else
  if [[ -n "${WHATSAPP_REAL_BIN+x}" ]]; then
    watcher_env=(WHATSAPP_BIN="$whatsapp_cli_wrapper" WHATSAPP_REAL_BIN="$whatsapp_bin" OPENCODE_BIN="$opencode_bin")
  elif [[ -n "${WHATSAPP_BIN+x}" ]]; then
    watcher_env=(WHATSAPP_BIN="$whatsapp_bin" OPENCODE_BIN="$opencode_bin")
  else
    watcher_env=(WHATSAPP_BIN="$whatsapp_cli_wrapper" WHATSAPP_REAL_BIN="$whatsapp_bin" OPENCODE_BIN="$opencode_bin")
  fi

  if [[ -n "$request_kinds" ]]; then
    watcher_env+=(WHATSAPP_REQUEST_KINDS="$request_kinds")
  fi

  nohup env "${watcher_env[@]}" "$node_bin" "$watcher_script" --server-url "$server_url" --model "$model" --agent "$agent" --prompt "$prompt" >"$watcher_log_file" 2>&1 &
  watcher_pid="$!"
  printf '%s\n' "$watcher_pid" >"$watcher_pid_file"
  watcher_status="started"
  sleep 1

  if ! kill -0 "$watcher_pid" >/dev/null 2>&1; then
    printf 'WhatsApp heartbeat watcher exited during startup\n' >&2
    printf 'Watcher log: %s\n' "$watcher_log_file" >&2
    exit 1
  fi
fi

printf 'OpenCode server %s at %s\n' "$server_status" "$server_url"
if [[ -n "$server_pid" ]]; then
  printf 'Server PID: %s\n' "$server_pid"
fi
printf 'Server log: %s\n' "$server_log_file"

printf 'WhatsApp heartbeat watcher %s\n' "$watcher_status"
if [[ -n "$watcher_pid" ]]; then
  printf 'Watcher PID: %s\n' "$watcher_pid"
fi
printf 'Watcher log: %s\n' "$watcher_log_file"
