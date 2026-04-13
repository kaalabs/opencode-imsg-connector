#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'Usage: %s [options]\n' "${0##*/}" >&2
  printf 'Options:\n' >&2
  printf '  --app-name NAME               App bundle name (default: OWPENbot Connector)\n' >&2
  printf '  --bundle-id ID                Bundle identifier (default: com.owpenbot.connector)\n' >&2
  printf '  --app-dir PATH                App install directory (default: $HOME/Applications)\n' >&2
  printf '  --node-bin PATH               Node binary to bundle (default: node)\n' >&2
  printf '  --imsg-bin PATH               imsg binary to bundle (default: imsg)\n' >&2
  printf '  --whatsapp-bin PATH           wu entrypoint to bundle (default: wu)\n' >&2
  printf '  --swiftc-bin PATH             swiftc binary (default: swiftc)\n' >&2
  printf '  --codesign-bin PATH           codesign binary (default: codesign)\n' >&2
  printf '  --codesign-identity NAME      Code-signing identity to use (default: local generated identity)\n' >&2
  printf '  --codesign-keychain PATH      Keychain containing the signing identity\n' >&2
  printf '  -h, --help                    Show this help\n' >&2
  exit "${1:-1}"
}

script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"

app_name="OWPENbot Connector"
bundle_id="com.owpenbot.connector"
app_dir="${HOME}/Applications"
node_bin="${NODE_BIN:-node}"
imsg_bin="${IMSG_BIN:-imsg}"
whatsapp_bin="${WHATSAPP_BIN:-wu}"
swiftc_bin="${SWIFTC_BIN:-swiftc}"
codesign_bin="${CODESIGN_BIN:-codesign}"
codesign_identity="${OWPENBOT_CODESIGN_IDENTITY:-}"
codesign_keychain="${OWPENBOT_CODESIGN_KEYCHAIN:-}"
ensure_identity_script="$script_dir/ensure-local-codesign-identity.sh"

resolve_homebrew_opt_binary() {
  local resolved_path="$1"
  local candidate=""

  case "$resolved_path" in
    /opt/homebrew/Cellar/node/*/bin/node)
      candidate="/opt/homebrew/opt/node/bin/node"
      ;;
    /usr/local/Cellar/node/*/bin/node)
      candidate="/usr/local/opt/node/bin/node"
      ;;
  esac

  if [[ -n "$candidate" && -x "$candidate" ]]; then
    printf '%s\n' "$candidate"
  else
    printf '%s\n' "$resolved_path"
  fi
}

resolve_imsg_binary() {
  local resolved_path="$1"
  local candidate="$(cd -- "$(dirname -- "$resolved_path")/../libexec" 2>/dev/null && pwd)/imsg"

  if [[ -x "$candidate" ]]; then
    printf '%s\n' "$candidate"
  else
    printf '%s\n' "$resolved_path"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
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
    --node-bin)
      [[ $# -ge 2 ]] || usage
      node_bin="$2"
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
    --swiftc-bin)
      [[ $# -ge 2 ]] || usage
      swiftc_bin="$2"
      shift 2
      ;;
    --codesign-bin)
      [[ $# -ge 2 ]] || usage
      codesign_bin="$2"
      shift 2
      ;;
    --codesign-identity)
      [[ $# -ge 2 ]] || usage
      codesign_identity="$2"
      shift 2
      ;;
    --codesign-keychain)
      [[ $# -ge 2 ]] || usage
      codesign_keychain="$2"
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

if [[ "$swiftc_bin" != */* ]]; then
  swiftc_bin="$(command -v "$swiftc_bin" || true)"
fi

if [[ ! -x "$swiftc_bin" ]]; then
  printf 'swiftc binary is not executable: %s\n' "$swiftc_bin" >&2
  exit 1
fi

if [[ "$node_bin" != */* ]]; then
  node_bin="$(command -v "$node_bin" || true)"
fi

if [[ ! -x "$node_bin" ]]; then
  printf 'node binary is not executable: %s\n' "$node_bin" >&2
  exit 1
fi

node_bin="$(resolve_homebrew_opt_binary "$(realpath "$node_bin")")"

if [[ "$imsg_bin" != */* ]]; then
  imsg_bin="$(command -v "$imsg_bin" || true)"
fi

if [[ ! -x "$imsg_bin" ]]; then
  printf 'imsg binary is not executable: %s\n' "$imsg_bin" >&2
  exit 1
fi

imsg_bin="$(resolve_imsg_binary "$(realpath "$imsg_bin")")"

if [[ "$whatsapp_bin" != */* ]]; then
  whatsapp_bin="$(command -v "$whatsapp_bin" || true)"
fi

if [[ ! -e "$whatsapp_bin" ]]; then
  printf 'whatsapp entrypoint does not exist: %s\n' "$whatsapp_bin" >&2
  exit 1
fi

if [[ "$codesign_bin" != */* ]]; then
  codesign_bin="$(command -v "$codesign_bin" || true)"
fi

launcher_source="$script_dir/macos/OWPenbotBackgroundLauncher.swift"
if [[ ! -f "$launcher_source" ]]; then
  printf 'launcher source not found: %s\n' "$launcher_source" >&2
  exit 1
fi

app_path="${app_dir}/${app_name}.app"
app_build_path="${app_path}.staging.$$"
contents_dir="${app_build_path}/Contents"
macos_dir="${contents_dir}/MacOS"
resources_dir="${contents_dir}/Resources"
service_dir="${resources_dir}/service"
runtime_dir="${resources_dir}/runtime"
runtime_bin_dir="${runtime_dir}/bin"
vendor_dir="${resources_dir}/vendor"
launcher_exec="${macos_dir}/OWPenbotBackgroundLauncher"
imsg_helper_exec="${macos_dir}/imsg"

mkdir -p "$app_dir"
rm -rf "$app_build_path"
mkdir -p "$macos_dir" "$service_dir" "$runtime_bin_dir" "$vendor_dir"

"$swiftc_bin" "$launcher_source" -o "$launcher_exec"

cat > "${contents_dir}/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>en</string>
    <key>CFBundleExecutable</key>
    <string>OWPenbotBackgroundLauncher</string>
    <key>CFBundleIdentifier</key>
    <string>${bundle_id}</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>${app_name}</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSAppleEventsUsageDescription</key>
    <string>OWPENbot Connector needs automation access to interact with Messages when sending replies.</string>
  </dict>
</plist>
EOF

printf 'APPL????' > "${contents_dir}/PkgInfo"

install -m 0755 "$node_bin" "${runtime_bin_dir}/node"
cat > "${runtime_bin_dir}/node" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec "${node_bin}" "\$@"
EOF
chmod 0755 "${runtime_bin_dir}/node"

install -m 0755 "$imsg_bin" "$imsg_helper_exec"

wu_entry_path="$(realpath "$whatsapp_bin")"
wu_package_root="$(cd -- "$(dirname -- "$wu_entry_path")/../.." && pwd)"
rm -rf "${vendor_dir}/wu-cli"
cp -R "$wu_package_root" "${vendor_dir}/wu-cli"

cat > "${runtime_bin_dir}/wu" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
runtime_dir="$(cd -- "$script_dir/.." && pwd)"
resources_dir="$(cd -- "$runtime_dir/.." && pwd)"
exec "${runtime_dir}/bin/node" "${resources_dir}/vendor/wu-cli/dist/cli/index.js" "$@"
EOF
chmod 0755 "${runtime_bin_dir}/wu"

for file_name in \
  run-all-heartbeat-service.js \
  watch-rc-heartbeat.js \
  watch-whatsapp-heartbeat.js \
  whatsapp-controller.js \
  whatsapp-cli.js \
  rc-heartbeat.sh
do
  install -m 0755 "${script_dir}/${file_name}" "${service_dir}/${file_name}"
done

if [[ ! -x "$codesign_bin" ]]; then
  printf 'codesign binary is not executable: %s\n' "$codesign_bin" >&2
  exit 1
fi

if [[ -z "$codesign_identity" && -f "$ensure_identity_script" ]]; then
  ensure_output="$(bash "$ensure_identity_script" --print)"
  codesign_identity="${ensure_output%%|*}"
  codesign_keychain="${ensure_output#*|}"
fi

if [[ -z "$codesign_identity" ]]; then
  printf 'no code-signing identity available\n' >&2
  exit 1
fi

sign_args=(--force --sign "$codesign_identity" --timestamp=none)
if [[ -n "$codesign_keychain" ]]; then
  sign_args+=(--keychain "$codesign_keychain")
fi

"$codesign_bin" "${sign_args[@]}" --identifier "${bundle_id}.imsg" "$imsg_helper_exec"
"$codesign_bin" "${sign_args[@]}" "$launcher_exec"
"$codesign_bin" "${sign_args[@]}" "$app_build_path"
"$codesign_bin" --verify --verbose=2 "$app_build_path"

app_backup_path=""
if [[ -e "$app_path" ]]; then
  app_backup_path="${app_path}.backup.$$"
  rm -rf "$app_backup_path"
  mv "$app_path" "$app_backup_path"
fi

if ! mv "$app_build_path" "$app_path"; then
  if [[ -n "$app_backup_path" && -e "$app_backup_path" ]]; then
    mv "$app_backup_path" "$app_path" || true
  fi
  printf 'failed to move staged app bundle into place\n' >&2
  exit 1
fi

if [[ -n "$app_backup_path" ]]; then
  rm -rf "$app_backup_path"
fi

final_launcher_exec="${app_path}/Contents/MacOS/OWPenbotBackgroundLauncher"

printf 'App bundle: %s\n' "$app_path"
printf 'Executable: %s\n' "$final_launcher_exec"
