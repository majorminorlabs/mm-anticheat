#!/bin/sh
# Run inside an installed checkout. Suitable for terminal recording/screenshots.
set -eu
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
demo_root=$(mktemp -d "${TMPDIR:-/tmp}/mm-anticheat-demo.XXXXXXXX")
trap 'rm -rf -- "$demo_root"' EXIT HUP INT TERM
cp -R "$repo_root/tests/fixtures/cross/classic_cheat/base/." "$demo_root/"
git -c core.fsmonitor=false -c core.untrackedCache=false -C "$demo_root" init -q
git -c core.fsmonitor=false -c core.untrackedCache=false -C "$demo_root" -c user.name=Demo -c user.email=demo@example.test add .
git -c core.fsmonitor=false -c core.untrackedCache=false -C "$demo_root" -c user.name=Demo -c user.email=demo@example.test commit -qm base
cp -R "$repo_root/tests/fixtures/cross/classic_cheat/head/." "$demo_root/"
printf 'Classic-cheat working scan (expected exit 1)\n'
code=0
(cd "$demo_root" && "${ANTICHEAT_PYTHON:-python3}" -I -m mm_anticheat.cli scan --working --capture-on-block) || code=$?
test "$code" -eq 1
git -c core.fsmonitor=false -c core.untrackedCache=false -C "$demo_root" reset --hard -q HEAD
printf '\nReverted working scan (expected exit 0)\n'
(cd "$demo_root" && "${ANTICHEAT_PYTHON:-python3}" -I -m mm_anticheat.cli scan --working)
