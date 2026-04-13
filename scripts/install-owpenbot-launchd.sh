#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'Usage: %s [options]\\n' "${0##*/}" >&2
  printf 'Options:\\n' >&2
  printf '  --label LABEL                 LaunchAgent label (default: com.owpenbot.imessage-connector)\\n' >&2
  printf '  --app-name NAME              App bundle name (default: OWPENbot Connector)\\n' >&2
  printf '  --bundle-id ID               App bundle identifier (default: com.owpenbot.connector)\\n' >&2
  printf '  --app-dir PATH               App install dir (default: $HOME/Applications)\\n' >&2
  printf '  --runtime-dir PATH            Runtime directory for state/logs (default: %s)\\n' "${TMPDIR:-/tmp}/opencode-imsg-connector" >&2
  printf '  --hostname HOST               Hostname passed to start script (default: 127.0.0.1)\\n' >&2
  printf '  --port PORT                   Port passed to start script (default: 4096)\\n' >&2
  printf '  --model MODEL                 Model passed to watcher (default: openai/gpt-5.4)\\n' >&2
  printf '  --agent AGENT                 Agent passed to watcher (default: build)\\n' >&2
  printf '  --prompt PROMPT               Prompt passed to watcher (default: RC_HEARTBEAT)\\n' >&2
  printf '  --imsg-bin PATH               Path to imsg binary (default: imsg)\\n' >&2
  printf '  --whatsapp-bin PATH           Path to WhatsApp CLI (default: wu)\\n' >&2
  printf '  --whatsapp-real-bin PATH      Path to real WhatsApp CLI when using wrapper\\n' >&2
  printf '  --opencode-bin PATH           Path to opencode binary (default: opencode)\\n' >&2
  printf '  --node-bin PATH               Path to node binary (default: node)\\n' >&2
  printf '  --request-kinds JSON          Optional OWPENBOT_REQUEST_KINDS override JSON\\n' >&2
  printf '  --whatsapp-request-kinds JSON Optional WHATSAPP_REQUEST_KINDS override JSON\\n' >&2
  printf '  --build-app-script PATH       App builder script (default: scripts/build-owpenbot-launcher-app.sh)\\n' >&2
  printf '  --plist-dir PATH              LaunchAgents directory (default: $HOME/Library/LaunchAgents)\\n' >&2
  printf '  --load                        Bootstrap now with launchctl\\n' >&2
  printf '  -h, --help                    Show this help\\n' >&2
  exit 1
}

escape_xml() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/\"/\&quot;/g'
}

script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"

label="com.owpenbot.imessage-connector"
app_name="OWPENbot Connector"
bundle_id="com.owpenbot.connector"
app_dir="${HOME}/Applications"
runtime_dir="${RUNTIME_DIR:-${TMPDIR:-/tmp}/opencode-imsg-connector}"
hostname="127.0.0.1"
port="4096"
model="openai/gpt-5.4"
agent="build"
prompt="RC_HEARTBEAT"
imsg_bin="${IMSG_BIN:-imsg}"
whatsapp_bin="${WHATSAPP_BIN:-wu}"
whatsapp_real_bin="${WHATSAPP_REAL_BIN:-}"
opencode_bin="${OPENCODE_BIN:-opencode}"
node_bin="${NODE_BIN:-node}"
request_kinds=""
whatsapp_request_kinds=""
build_app_script="$script_dir/build-owpenbot-launcher-app.sh"
plist_dir="${HOME}/Library/LaunchAgents"
should_load=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --label)
      [[ $# -ge 2 ]] || usage
      label="$2"
      shift 2
      ;;
    --app-name)
      [[ $# -ge 2 ]] || usage
      app_name="$2"
      shift 2
      ;;
    --bundle-id)
      [[ $# -ge 2 ]] || usage
      bundle_id="$2"
      shift 2
      ;;
    --app-dir)
      [[ $# -ge 2 ]] || usage
      app_dir="$2"
      shift 2
      ;;
    --runtime-dir)
      [[ $# -ge 2 ]] || usage
      runtime_dir="$2"
      shift 2
      ;;
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
    --build-app-script)
      [[ $# -ge 2 ]] || usage
      build_app_script="$2"
      shift 2
      ;;
    --plist-dir)
      [[ $# -ge 2 ]] || usage
      plist_dir="$2"
      shift 2
      ;;
    --load)
      should_load=1
      shift
      ;;
    -h|--help)
      usage
      ;;
    *)
      printf 'Unknown argument: %s\\n' "$1" >&2
      usage
      ;;
  esac
done

if [[ "$build_app_script" != /* ]]; then
  build_app_script="$repo_root/$build_app_script"
fi

if [[ ! -x "$build_app_script" ]]; then
  printf 'build app script is not executable: %s\\n' "$build_app_script" >&2
  exit 1
fi

if [[ "$node_bin" != */* ]]; then
  node_bin="$(command -v "$node_bin" || true)"
fi

if [[ ! -x "$node_bin" ]]; then
  printf 'node binary is not executable: %s\\n' "$node_bin" >&2
  exit 1
fi

if [[ "$imsg_bin" != */* ]]; then
  imsg_bin="$(command -v "$imsg_bin" || true)"
fi

if [[ ! -x "$imsg_bin" ]]; then
  printf 'imsg binary not found/executable: %s\\n' "$imsg_bin" >&2
  exit 1
fi

if [[ "$whatsapp_bin" != */* ]]; then
  whatsapp_bin="$(command -v "$whatsapp_bin" || true)"
fi

if [[ ! -x "$whatsapp_bin" ]]; then
  printf 'whatsapp binary not found/executable: %s\\n' "$whatsapp_bin" >&2
  exit 1
fi

if [[ -n "$whatsapp_real_bin" && "$whatsapp_real_bin" != */* ]]; then
  whatsapp_real_bin="$(command -v "$whatsapp_real_bin" || true)"
fi

if [[ -n "$whatsapp_real_bin" && ! -x "$whatsapp_real_bin" ]]; then
  printf 'whatsapp real binary not found/executable: %s\\n' "$whatsapp_real_bin" >&2
  exit 1
fi

if [[ "$opencode_bin" != */* ]]; then
  opencode_bin="$(command -v "$opencode_bin" || true)"
fi

if [[ ! -x "$opencode_bin" ]]; then
  printf 'opencode binary is not executable: %s\\n' "$opencode_bin" >&2
  exit 1
fi

"$build_app_script" \
  --app-name "$app_name" \
  --bundle-id "$bundle_id" \
  --app-dir "$app_dir" \
  --node-bin "$node_bin" \
  --imsg-bin "$imsg_bin" \
  --whatsapp-bin "$whatsapp_bin"

app_path="${app_dir}/${app_name}.app"
launcher_exec="${app_path}/Contents/MacOS/OWPenbotBackgroundLauncher"
bundled_runtime_dir="${app_path}/Contents/Resources/runtime"
bundled_vendor_dir="${app_path}/Contents/Resources/vendor"
bundled_node_bin="${bundled_runtime_dir}/bin/node"
bundled_imsg_bin="${app_path}/Contents/MacOS/imsg"
bundled_whatsapp_bin="${bundled_runtime_dir}/bin/wu"
bundled_whatsapp_package_root="${bundled_vendor_dir}/wu-cli"

if [[ ! -x "$launcher_exec" ]]; then
  printf 'launcher executable not found: %s\\n' "$launcher_exec" >&2
  exit 1
fi

if [[ ! -x "$bundled_node_bin" ]]; then
  printf 'bundled node binary not found: %s\\n' "$bundled_node_bin" >&2
  exit 1
fi

if [[ ! -x "$bundled_imsg_bin" ]]; then
  printf 'bundled imsg binary not found: %s\\n' "$bundled_imsg_bin" >&2
  exit 1
fi

if [[ ! -x "$bundled_whatsapp_bin" ]]; then
  printf 'bundled whatsapp binary not found: %s\\n' "$bundled_whatsapp_bin" >&2
  exit 1
fi

mkdir -p "$runtime_dir"
mkdir -p "$plist_dir"

plist_path="$plist_dir/$label.plist"
escaped_home="$(escape_xml "$HOME")"
escaped_runtime_dir="$(escape_xml "$runtime_dir")"
escaped_imsg_bin="$(escape_xml "$bundled_imsg_bin")"
escaped_whatsapp_bin="$(escape_xml "$bundled_whatsapp_bin")"
escaped_whatsapp_package_root="$(escape_xml "$bundled_whatsapp_package_root")"
escaped_opencode_bin="$(escape_xml "$opencode_bin")"
escaped_node_bin="$(escape_xml "$bundled_node_bin")"
escaped_label="$(escape_xml "$label")"
escaped_launcher_exec="$(escape_xml "$launcher_exec")"
escaped_hostname="$(escape_xml "$hostname")"
escaped_port="$(escape_xml "$port")"
escaped_model="$(escape_xml "$model")"
escaped_agent="$(escape_xml "$agent")"
escaped_prompt="$(escape_xml "$prompt")"

request_lines=""
if [[ -n "$request_kinds" ]]; then
  escaped_request_kinds="$(escape_xml "$request_kinds")"
  request_lines="$request_lines
      <key>OWPENBOT_REQUEST_KINDS</key>
      <string>$escaped_request_kinds</string>"
fi

if [[ -n "$whatsapp_request_kinds" ]]; then
  escaped_whatsapp_request_kinds="$(escape_xml "$whatsapp_request_kinds")"
  request_lines="$request_lines
      <key>WHATSAPP_REQUEST_KINDS</key>
      <string>$escaped_whatsapp_request_kinds</string>"
fi

if [[ -n "$whatsapp_real_bin" ]]; then
  escaped_whatsapp_real_bin="$(escape_xml "$whatsapp_real_bin")"
  request_lines="$request_lines
      <key>WHATSAPP_REAL_BIN</key>
      <string>$escaped_whatsapp_real_bin</string>"
fi

cat > "$plist_path" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${escaped_label}</string>

    <key>ProgramArguments</key>
    <array>
      <string>${escaped_launcher_exec}</string>
      <string>--node-bin</string>
      <string>${escaped_node_bin}</string>
      <string>--hostname</string>
      <string>${escaped_hostname}</string>
      <string>--port</string>
      <string>${escaped_port}</string>
      <string>--model</string>
      <string>${escaped_model}</string>
      <string>--agent</string>
      <string>${escaped_agent}</string>
      <string>--prompt</string>
      <string>${escaped_prompt}</string>
      <string>--runtime-dir</string>
      <string>${escaped_runtime_dir}</string>
      <string>--imsg-bin</string>
      <string>${escaped_imsg_bin}</string>
      <string>--whatsapp-bin</string>
      <string>${escaped_whatsapp_bin}</string>
EOF

if [[ -n "$whatsapp_real_bin" ]]; then
cat >> "$plist_path" <<EOF
      <string>--whatsapp-real-bin</string>
      <string>${escaped_whatsapp_real_bin}</string>
EOF
fi

cat >> "$plist_path" <<EOF
      <string>--opencode-bin</string>
      <string>${escaped_opencode_bin}</string>
      <string>--node-bin</string>
      <string>${escaped_node_bin}</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
      <key>HOME</key>
      <string>${escaped_home}</string>
      <key>PATH</key>
      <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
      <key>IMSG_BIN</key>
      <string>${escaped_imsg_bin}</string>
      <key>WHATSAPP_BIN</key>
      <string>${escaped_whatsapp_bin}</string>
      <key>WHATSAPP_PACKAGE_ROOT</key>
      <string>${escaped_whatsapp_package_root}</string>
      <key>OPENCODE_BIN</key>
      <string>${escaped_opencode_bin}</string>
      <key>NODE_BIN</key>
      <string>${escaped_node_bin}</string>
      <key>RUNTIME_DIR</key>
      <string>${escaped_runtime_dir}</string>
      ${request_lines}
    </dict>

    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>${escaped_home}</string>
    <key>ThrottleInterval</key>
    <integer>5</integer>

    <key>StandardOutPath</key>
    <string>${escaped_runtime_dir}/launchd.out.log</string>
    <key>StandardErrorPath</key>
    <string>${escaped_runtime_dir}/launchd.err.log</string>
  </dict>
</plist>
EOF

printf 'Generated: %s\\n' "$plist_path"

if [[ $should_load -eq 1 ]]; then
  gui_domain="gui/$(id -u)"
  launchctl bootout "$gui_domain" "$plist_path" 2>/dev/null || true
  launchctl bootstrap "$gui_domain" "$plist_path"
  printf 'Loaded as: %s\\n' "$label"
else
  printf 'Not loading by default. Start it with:\\n  launchctl bootstrap gui/$(id -u) %s\\n' "$plist_path"
  printf 'If it already exists, refresh with:\\n  launchctl bootout gui/$(id -u) %s || true\\n  launchctl bootstrap gui/$(id -u) %s\\n' "$plist_path" "$plist_path"
fi
