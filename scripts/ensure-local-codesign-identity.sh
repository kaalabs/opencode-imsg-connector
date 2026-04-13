#!/usr/bin/env bash
set -euo pipefail

identity_name="${OWPENBOT_CODESIGN_IDENTITY:-OWPENbot Local Code Signing}"
keychain_path="${OWPENBOT_CODESIGN_KEYCHAIN:-${HOME}/Library/Keychains/owpenbot-local-codesign.keychain-db}"
keychain_password="${OWPENBOT_CODESIGN_KEYCHAIN_PASSWORD:-owpenbot-local-codesign}"
pkcs12_password="${OWPENBOT_CODESIGN_PKCS12_PASSWORD:-owpenbot-local-codesign-p12}"

usage() {
  printf 'Usage: %s [--print]\n' "${0##*/}" >&2
  exit "${1:-1}"
}

print_only=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --print)
      print_only=1
      shift
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

ensure_keychain() {
  if [[ ! -f "$keychain_path" ]]; then
    security create-keychain -p "$keychain_password" "$keychain_path" >/dev/null
  fi

  security unlock-keychain -p "$keychain_password" "$keychain_path" >/dev/null

  local existing_keychains
  existing_keychains="$(security list-keychains -d user | tr -d '"' || true)"

  if ! printf '%s\n' "$existing_keychains" | grep -Fqx "$keychain_path"; then
    security list-keychains -d user -s "$keychain_path" ${existing_keychains} >/dev/null
  fi
}

identity_exists() {
  [[ -n "$(identity_hash || true)" ]]
}

matching_certificate_hashes() {
  security find-certificate -Z -a -c "$identity_name" "$keychain_path" 2>/dev/null | awk '/SHA-1 hash:/ { print $3 }'
}

identity_hash() {
  matching_certificate_hashes | head -n 1
}

dedupe_identity_certificates() {
  local keep_hash=""
  local hash=""

  keep_hash="$(identity_hash || true)"
  if [[ -z "$keep_hash" ]]; then
    return 0
  fi

  while IFS= read -r hash; do
    [[ -n "$hash" ]] || continue
    if [[ "$hash" != "$keep_hash" ]]; then
      security delete-certificate -Z "$hash" "$keychain_path" >/dev/null 2>&1 || true
    fi
  done < <(matching_certificate_hashes)
}

create_identity() {
  local tmp_dir
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' RETURN

  openssl req \
    -x509 \
    -newkey rsa:2048 \
    -nodes \
    -days 3650 \
    -subj "/CN=${identity_name}" \
    -addext "basicConstraints=critical,CA:FALSE" \
    -addext "keyUsage=critical,digitalSignature" \
    -addext "extendedKeyUsage=critical,codeSigning" \
    -keyout "$tmp_dir/key.pem" \
    -out "$tmp_dir/cert.pem" >/dev/null 2>&1

  openssl pkcs12 \
    -export \
    -legacy \
    -inkey "$tmp_dir/key.pem" \
    -in "$tmp_dir/cert.pem" \
    -out "$tmp_dir/identity.p12" \
    -passout "pass:${pkcs12_password}" >/dev/null 2>&1

  security import "$tmp_dir/identity.p12" \
    -k "$keychain_path" \
    -P "$pkcs12_password" \
    -T /usr/bin/codesign \
    -T /usr/bin/security >/dev/null

  security set-key-partition-list \
    -S apple-tool:,apple: \
    -s \
    -k "$keychain_password" \
    "$keychain_path" >/dev/null
}

ensure_keychain

if ! identity_exists; then
  create_identity
fi

dedupe_identity_certificates

resolved_identity_hash="$(identity_hash || true)"
if [[ -z "$resolved_identity_hash" ]]; then
  printf 'failed to resolve local code-signing certificate hash\n' >&2
  exit 1
fi

if [[ "$print_only" -eq 1 ]]; then
  printf '%s|%s\n' "$resolved_identity_hash" "$keychain_path"
else
  printf 'Identity: %s\n' "$resolved_identity_hash"
  printf 'Keychain: %s\n' "$keychain_path"
fi
