#!/usr/bin/env bash
set -euo pipefail

usage() {
  local code="${1:-1}"
  printf 'Usage: %s [--hostname HOST] [--port PORT] [--model PROVIDER/MODEL] [--agent AGENT] [--prompt PROMPT] [--runtime-dir DIR] [--imsg-bin PATH] [--whatsapp-bin PATH] [--whatsapp-real-bin PATH] [--request-kinds JSON] [--whatsapp-request-kinds JSON] [--opencode-bin PATH] [--node-bin PATH] [--curl-bin PATH]\n' "${0##*/}" >&2
  exit "$code"
}

hostname="127.0.0.1"
port="4096"
model="openai/gpt-5.4"
agent="build"
prompt="RC_HEARTBEAT"
runtime_dir="${RUNTIME_DIR:-${TMPDIR:-/tmp}/opencode-imsg-connector}"
request_kinds=""
whatsapp_request_kinds=""

imsg_bin="${IMSG_BIN:-imsg}"
whatsapp_bin="${WHATSAPP_BIN:-/opt/homebrew/bin/wu}"
whatsapp_real_bin="${WHATSAPP_REAL_BIN:-}"
opencode_bin="${OPENCODE_BIN:-opencode}"
node_bin="${NODE_BIN:-node}"
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
    --imsg-bin)
      [[ $# -ge 2 ]] || usage
      imsg_bin="$2"
      shift 2
      ;;
    --whatsapp-bin)
      [[ $# -ge 2 ]] || usage
      whatsapp_bin="$2"
      shift 2
      ;;
    --whatsapp-real-bin)
      [[ $# -ge 2 ]] || usage
      whatsapp_real_bin="$2"
      shift 2
      ;;
    --request-kinds)
      [[ $# -ge 2 ]] || usage
      request_kinds="$2"
      shift 2
      ;;
    --whatsapp-request-kinds)
      [[ $# -ge 2 ]] || usage
      whatsapp_request_kinds="$2"
      shift 2
      ;;
    --opencode-bin)
      [[ $# -ge 2 ]] || usage
      opencode_bin="$2"
      shift 2
      ;;
    --node-bin)
      [[ $# -ge 2 ]] || usage
      node_bin="$2"
      shift 2
      ;;
    --curl-bin)
      [[ $# -ge 2 ]] || usage
      curl_bin="$2"
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

if ! command -v "$opencode_bin" >/dev/null 2>&1; then
  printf 'Required command not found: %s\n' "$opencode_bin" >&2
  exit 1
fi

if ! command -v "$node_bin" >/dev/null 2>&1; then
  printf 'Required command not found: %s\n' "$node_bin" >&2
  exit 1
fi

if ! command -v "$imsg_bin" >/dev/null 2>&1; then
  printf 'Required command not found: %s\n' "$imsg_bin" >&2
  exit 1
fi

if ! command -v "$whatsapp_bin" >/dev/null 2>&1; then
  printf 'Required command not found: %s\n' "$whatsapp_bin" >&2
  exit 1
fi

if ! command -v "$curl_bin" >/dev/null 2>&1; then
  printf 'Required command not found: %s\n' "$curl_bin" >&2
  exit 1
fi

if [[ -n "$whatsapp_real_bin" ]] && ! command -v "$whatsapp_real_bin" >/dev/null 2>&1; then
  printf 'Required command not found: %s\n' "$whatsapp_real_bin" >&2
  exit 1
fi

script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
service_script="$script_dir/run-all-heartbeat-service.js"
supervisor_pid_file="${runtime_dir}/heartbeat-supervisor.pid"
supervisor_log_file="${runtime_dir}/heartbeat-supervisor.log"

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

wait_for_file_pid() {
  local file_path="$1"
  local attempts=30

  while (( attempts > 0 )); do
    if read_pid_file "$file_path" >/dev/null 2>&1; then
      return 0
    fi

    sleep 0.2
    attempts=$((attempts - 1))
  done

  return 1
}

service_args=(
  --hostname "$hostname"
  --port "$port"
  --model "$model"
  --agent "$agent"
  --prompt "$prompt"
  --runtime-dir "$runtime_dir"
)

if [[ -n "$request_kinds" ]]; then
  service_args+=(--request-kinds "$request_kinds")
fi

if [[ -n "$whatsapp_request_kinds" ]]; then
  service_args+=(--whatsapp-request-kinds "$whatsapp_request_kinds")
fi

if [[ -n "$whatsapp_real_bin" ]]; then
  service_args+=(--whatsapp-real-bin "$whatsapp_real_bin")
fi

supervisor_status="reused"
supervisor_pid=""

if supervisor_pid="$(read_pid_file "$supervisor_pid_file" 2>/dev/null)"; then
  supervisor_status="already running"
else
  nohup env \
    IMSG_BIN="$imsg_bin" \
    WHATSAPP_BIN="$whatsapp_bin" \
    OPENCODE_BIN="$opencode_bin" \
    NODE_BIN="$node_bin" \
    CURL_BIN="$curl_bin" \
    "$node_bin" "$service_script" "${service_args[@]}" --imsg-bin "$imsg_bin" --whatsapp-bin "$whatsapp_bin" --opencode-bin "$opencode_bin" --node-bin "$node_bin" >"$supervisor_log_file" 2>&1 &
  supervisor_pid="$!"
  printf '%s\n' "$supervisor_pid" >"$supervisor_pid_file"
  supervisor_status="started"
  sleep 2

  if ! kill -0 "$supervisor_pid" >/dev/null 2>&1; then
    printf 'Heartbeat supervisor exited during startup\n' >&2
    printf 'Supervisor log: %s\n' "$supervisor_log_file" >&2
    exit 1
  fi
fi

if ! "$curl_bin" -fsS "http://${hostname}:${port}/global/health" >/dev/null 2>&1; then
  printf 'OpenCode server failed to become healthy at http://%s:%s\n' "$hostname" "$port" >&2
  printf 'Supervisor log: %s\n' "$supervisor_log_file" >&2
  exit 1
fi

if ! wait_for_file_pid "${runtime_dir}/rc-heartbeat-watcher.pid"; then
  printf 'RC heartbeat watcher did not come up\n' >&2
  printf 'Supervisor log: %s\n' "$supervisor_log_file" >&2
  exit 1
fi

if ! wait_for_file_pid "${runtime_dir}/whatsapp-heartbeat-watcher.pid"; then
  printf 'WhatsApp heartbeat watcher did not come up\n' >&2
  printf 'Supervisor log: %s\n' "$supervisor_log_file" >&2
  exit 1
fi

printf 'Heartbeat supervisor %s\n' "$supervisor_status"
if [[ -n "$supervisor_pid" ]]; then
  printf 'Supervisor PID: %s\n' "$supervisor_pid"
fi
printf 'Supervisor log: %s\n' "$supervisor_log_file"
printf 'Both watchers started against: %s\n' "http://${hostname}:${port}"
printf 'Runtime directory: %s\n' "$runtime_dir"
