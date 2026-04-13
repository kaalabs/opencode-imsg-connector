#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
node_bin="${NODE_BIN:-node}"

if ! command -v "$node_bin" >/dev/null 2>&1; then
  printf 'Required command not found: %s\n' "$node_bin" >&2
  exit 1
fi

exec "$node_bin" "$script_dir/run-all-heartbeat-service.js" "$@"
