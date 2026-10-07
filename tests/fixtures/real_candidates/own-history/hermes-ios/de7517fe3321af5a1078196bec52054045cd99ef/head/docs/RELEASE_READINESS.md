# Talaria v0.1.0 release preparation

Prepared 2026-10-04 on `codex/bot-mode-milestone`, following physical acceptance
commit `bc92829`. Version `0.1.0`, build `1`; bundle `com.dippo.hermes` preserved.
No push, tag, publication or SideStore installation has been performed.

## Artifacts

Generated under the ignored `build/release/v0.1.0/` directory:

| Artifact | State |
| --- | --- |
| `Talaria-v0.1.0.xcarchive` | Device-target Release archive, unsigned |
| `Talaria-v0.1.0.ipa` | Resignable `Payload/Hermes.app`; no signature/provisioning profile |
| `hermes-mobile-bridge-v0.1.0.tar.gz` | Clean source/service package, includes setup and usage guides |
| `SHA256SUMS.txt` | IPA and bridge hashes verified |

The app archive/IPA and bridge package were inspected recursively, including
compiled executable and debug symbols, for personal home/volume/temporary paths,
local account identity, private tailnet hostnames, physical-device identifiers,
private-key patterns and known local credential values. Final payload scan:
**no findings**. The package contains no saved host, runtime cache, private research
records, pairing state, virtual environment, logs or signing material. Public bundle
and launchd identifiers and legally required dependency attributions remain.
Bridge gzip/tar timestamps, user/group names and IDs are normalized. Two independent
packages from identical inputs matched byte for byte. IPA/archive builds are not
claimed byte-reproducible; Xcode metadata/UUIDs can differ between builds.

Rebuild and verify:

```sh
scripts/build-ios-release.sh --output-dir build/release/v0.1.0 \
  --sidestore-ipa --physical-validation-report PHYSICAL_DEVICE_TEST_REPORT.md
python3 scripts/audit-release-artifacts.py \
  build/release/v0.1.0/Talaria-v0.1.0.ipa \
  build/release/v0.1.0/hermes-mobile-bridge-v0.1.0.tar.gz \
  build/release/v0.1.0/Talaria-v0.1.0.xcarchive
cd build/release/v0.1.0
shasum -a 256 -c SHA256SUMS.txt
```

Use a fresh output directory when an archive already exists; the build script
refuses to replace it. Credential-aware auditing additionally accepts private
`--secret-file` paths; contents are compared in memory and never printed.

## Checks performed

| Check | Result |
| --- | --- |
| Swift unit/integration | 57 passed |
| Swift UI | 12 passed |
| Swift explicit opt-in skips | 21; zero failures |
| Bridge suite | 59 passed, one installed-Hermes opt-in skip |
| Service/deployment safety | 9 passed |
| Release privacy/reproducibility regression | 4 passed |
| Distinct tests this release pass | **141 passed, 22 skipped, zero failures** |
| Focused Swift rerun after demo-data sanitization | 62 passed, 3 opt-in skips, zero failures; overlap excluded above |
| Simulator Debug build | Passed with the Swift suites |
| Device Release/archive | Passed |
| Extracted bridge clean-venv installation and CLI | Passed |
| Extracted installer/update/uninstall/status help | Passed |
| Artifact checksums | Passed |

No Swift compiler warnings were found. Xcode emitted its AppIntents metadata
warning because the app does not use AppIntents; no framework was added merely
to suppress that tool warning. No unrelated research experiment was rerun.

## Security and repository hygiene

The release review checked bearer authentication and scopes before routing,
loopback binding/Tailscale Serve ownership and Funnel refusal, owner-only secret
files, Keychain storage, bounded type-checked uploads, generated upload IDs,
conversation ownership/idempotency, no-follow artifact path traversal protection,
allowlisted bot mutations and argument-list subprocess execution. No concrete
release-blocking product issue was found in those boundaries. This is a scoped
source/artifact review, not a claim of independent penetration testing.

Personal signing configuration is retained in ignored `Signing.local.xcconfig`
(mode 0600), loaded optionally through `Config/Build.xcconfig`. Local build settings
confirmed the existing Team remains usable. The public project contains no personal
Team value. Original local project/scheme signing changes were backed up privately;
local scheme preferences remain in ignored `xcuserdata`. Release builds explicitly
clear Team/signing settings and remap source/debug paths. Ignore rules cover signing,
credentials, local environment, caches, build products, logs and device evidence.

Current shipped source/docs and artifacts contain no detected private values.
Controlled negative-test fixtures contain deliberately fake paths/hosts. Historical
commits still contain personal paths/host metadata and a personal Team identifier;
no known bearer/provider credential was found in that history scan. A Team identifier
is signing metadata, not an Apple password/private key. History has been preserved
as requested, so **the existing repository is not cleared for public push under the
strict privacy requirement**. Resolve historical metadata separately before publishing;
do not assume a sanitized current tree removes old Git blobs. Source-grounded
validation documents remain, with private record identifiers redacted. The Research
Terminal handoff patch retains its original changes without private baseline context.

## Physical device and SideStore gate

Prior physical acceptance passed chat/bots/research/media/dictation and Wi-Fi/Tailscale;
see [physical report](../PHYSICAL_DEVICE_TEST_REPORT.md). No broad physical feature
retest was required for this documentation/packaging pass. Cellular-only routing,
a full reboot and long-term signing refresh are not claimed.

The connected phone still has Talaria `0.1.0` / build `1` installed. Its Library
was backed up outside the repository to an owner-only directory (22 files,
including preferences and cached state). Saved host configuration was present.
No Keychain extraction or app uninstall occurred. Backup paths/contents are private
and excluded from all packages.

**SideStore update/data preservation: PENDING.** Device inventory confirms SideStore
and LocalDevVPN are absent. Required human step: complete SideStore Stable setup
using the same Apple Account used for the current Xcode app; leave Talaria installed.
Follow [SideStore setup](SIDESTORE.md). Then import the generated IPA over Talaria,
launch it, verify the saved host/auth/conversations/preferences, and refresh it once.
Signing identity/access-group changes can require re-pairing; no preservation claim
is made before this real update succeeds. Apple Account credentials stay in the
normal signing UI and are not handled by Talaria/the bridge.

## License and remaining limits

MIT was explicitly selected by the owner. LICENSE and third-party notices are
included; Hermes is an external MIT-licensed backend. Apple system frameworks remain
subject to Apple's terms. No third-party Swift package is bundled.

No APNs/background push; suspended clients reconcile on reopen. Private Tailscale
connectivity and an awake, logged-in Mac are required. Available bot/media/task
operations depend on audited Hermes/bridge capabilities and configuration. Uploads
are bounded to 10 MiB/file and four/message. PDF previews need host Poppler. Dictation
prefers on-device recognition; Apple may use network recognition where unavailable.
Free-account signing needs seven-day refresh.

**Not ready to tag/publish** until SideStore update acceptance and the historical
privacy gate are resolved. No general UI polish is needed for this cleanup pass.
