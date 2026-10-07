#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="$ROOT/build/release"
SIDESTORE_IPA=0
PHYSICAL_REPORT=""

usage() {
  cat <<'EOF'
Usage: scripts/build-ios-release.sh [options]

Build a device Release archive and package the Studio bridge source.
An unsigned SideStore IPA is created only when both --sidestore-ipa and a
physical-device validation report with `physical_device_validation: PASS`
are supplied.

Options:
  --output-dir PATH                  Output directory (default: build/release)
  --sidestore-ipa                    Create the unsigned IPA for SideStore to sign
  --physical-validation-report PATH  Report containing the exact PASS marker
  -h, --help                         Show this help
EOF
}

while (($#)); do
  case "$1" in
    --output-dir)
      [[ $# -ge 2 ]] || { echo "Missing value for --output-dir" >&2; exit 2; }
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --sidestore-ipa)
      SIDESTORE_IPA=1
      shift
      ;;
    --physical-validation-report)
      [[ $# -ge 2 ]] || { echo "Missing value for --physical-validation-report" >&2; exit 2; }
      PHYSICAL_REPORT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ((SIDESTORE_IPA)); then
  if [[ -z "$PHYSICAL_REPORT" || ! -f "$PHYSICAL_REPORT" ]]; then
    echo "SideStore IPA creation requires --physical-validation-report PATH." >&2
    exit 2
  fi
  if ! /usr/bin/grep -Eq '^physical_device_validation:[[:space:]]*PASS[[:space:]]*$' "$PHYSICAL_REPORT"; then
    echo "The report must contain the exact line: physical_device_validation: PASS" >&2
    exit 2
  fi
fi

for command in xcodebuild git python3 shasum unzip zip; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "Required command not found: $command" >&2
    exit 1
  }
done

mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
if [[ "$OUTPUT_DIR" == "/" || "$OUTPUT_DIR" == "$ROOT" ]]; then
  echo "Choose a dedicated output directory, not the filesystem or repository root." >&2
  exit 2
fi
ARCHIVE_PATH="$OUTPUT_DIR/Hermes.xcarchive"
DERIVED_DATA="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/hermes-ios-derived.XXXXXX")"
IPA_STAGING=""
trap 'rm -rf "$DERIVED_DATA"; [[ -z "$IPA_STAGING" ]] || rm -rf "$IPA_STAGING"' EXIT

if [[ -L "$ARCHIVE_PATH" || -e "$ARCHIVE_PATH" ]]; then
  echo "Refusing to replace an existing archive: $ARCHIVE_PATH" >&2
  echo "Choose another --output-dir or remove the previous generated archive after inspection." >&2
  exit 1
fi
"$ROOT/scripts/package-bridge.sh" --output-dir "$OUTPUT_DIR"

echo "Building unsigned iOS Release archive (bundle ID is checked after build)."
xcodebuild \
  -project "$ROOT/Hermes.xcodeproj" \
  -scheme Hermes \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$DERIVED_DATA" \
  -archivePath "$ARCHIVE_PATH" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  archive

APP_PATH="$ARCHIVE_PATH/Products/Applications/Hermes.app"
INFO_PLIST="$APP_PATH/Info.plist"
[[ -d "$APP_PATH" && -f "$INFO_PLIST" ]] || {
  echo "The iOS archive does not contain Hermes.app." >&2
  exit 1
}

BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$INFO_PLIST")"
if [[ "$BUNDLE_ID" != "com.dippo.hermes" ]]; then
  echo "Unexpected bundle identifier: $BUNDLE_ID" >&2
  exit 1
fi

IPA_PATH=""
if ((SIDESTORE_IPA)); then
  IPA_STAGING="$(/usr/bin/mktemp -d "$OUTPUT_DIR/.sidestore-payload.XXXXXX")"
  mkdir -p "$IPA_STAGING/Payload"
  /usr/bin/ditto "$APP_PATH" "$IPA_STAGING/Payload/Hermes.app"

  # SideStore applies the device's signing identity during installation.
  /usr/bin/find "$IPA_STAGING/Payload/Hermes.app" -type d -name _CodeSignature -prune -exec rm -rf {} +
  /usr/bin/find "$IPA_STAGING/Payload/Hermes.app" -type f -name embedded.mobileprovision -delete
  IPA_PATH="$OUTPUT_DIR/Hermes.ipa"
  if [[ -L "$IPA_PATH" ]]; then
    echo "Refusing to replace a symlink at $IPA_PATH" >&2
    exit 1
  fi
  rm -f "$IPA_PATH"
  (cd "$IPA_STAGING" && /usr/bin/zip -qry "$IPA_PATH" Payload)
  rm -rf "$IPA_STAGING"
  IPA_STAGING=""

  if /usr/bin/unzip -Z1 "$IPA_PATH" | /usr/bin/grep -Eq '(^|/)(_CodeSignature|embedded\.mobileprovision)(/|$)'; then
    echo "Unsigned SideStore package still contains signing material." >&2
    rm -f "$IPA_PATH"
    exit 1
  fi
  /usr/bin/unzip -Z1 "$IPA_PATH" | /usr/bin/grep -qx 'Payload/Hermes.app/Info.plist' || {
    echo "Hermes.ipa has an invalid Payload/Hermes.app layout." >&2
    rm -f "$IPA_PATH"
    exit 1
  }
fi

SUMS="$OUTPUT_DIR/SHA256SUMS.txt"
: > "$SUMS"
for artifact in "$OUTPUT_DIR"/hermes-mobile-bridge-v*.tar.gz; do
  [[ -f "$artifact" ]] || continue
  (cd "$OUTPUT_DIR" && shasum -a 256 "$(basename "$artifact")") >> "$SUMS"
done
if [[ -n "$IPA_PATH" ]]; then
  (cd "$OUTPUT_DIR" && shasum -a 256 "$(basename "$IPA_PATH")") >> "$SUMS"
fi

echo "Release archive: $ARCHIVE_PATH"
BRIDGE_ARCHIVE="$(find "$OUTPUT_DIR" -maxdepth 1 -type f -name 'hermes-mobile-bridge-v*.tar.gz' -print -quit)"
echo "Bridge archive: ${BRIDGE_ARCHIVE:-$OUTPUT_DIR (not found)}"
echo "Checksums: $SUMS"
if [[ -n "$IPA_PATH" ]]; then
  echo "SideStore IPA: $IPA_PATH"
else
  echo "No IPA created. Physical-device PASS evidence is required before SideStore packaging."
fi
