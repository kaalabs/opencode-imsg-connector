#!/usr/bin/env bash
set -euo pipefail

usage() {
  local code="${1:-1}"
  printf 'Usage: %s --server-url URL [--model PROVIDER/MODEL] [--agent AGENT] --prompt PROMPT\n' "${0##*/}" >&2
  exit "$code"
}

server_url=""
model=""
agent=""
prompt=""
opencode_bin="${OPENCODE_BIN:-opencode}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server-url)
      [[ $# -ge 2 ]] || usage
      server_url="$2"
      shift 2
      ;;
    --prompt)
      [[ $# -ge 2 ]] || usage
      prompt="$2"
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
    -h|--help)
      usage 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage
      ;;
  esac
done

[[ -n "$server_url" ]] || usage
[[ -n "$prompt" ]] || usage

if ! command -v "$opencode_bin" >/dev/null 2>&1; then
  printf 'OpenCode CLI not found: %s\n' "$opencode_bin" >&2
  exit 1
fi

command=("$opencode_bin" run --attach "$server_url")

if [[ -n "$model" ]]; then
  command+=(--model "$model")
fi

if [[ -n "$agent" ]]; then
  command+=(--agent "$agent")
fi

command+=("$prompt")

exec "${command[@]}"
