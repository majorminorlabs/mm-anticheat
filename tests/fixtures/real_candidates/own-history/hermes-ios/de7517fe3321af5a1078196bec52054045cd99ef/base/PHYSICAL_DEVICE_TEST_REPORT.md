# Studio deployment and physical-device test report

Date: 2026-10-02. Upstream Hermes: `2a4c9afd7bd7b56d3e1f95524ca8956092f2904c`.

physical_device_validation: PENDING

No physical iPhone was installed or used in this pass. `xcrun devicectl list devices` returned **No devices found**; `security find-identity -v -p codesigning` returned **0 valid identities**. The candidate iPhone peer was offline in Tailscale. No personal Apple credentials, Team ID, certificate or provisioning profile were added to the repository. The app remains `com.dippo.hermes`, automatic signing, iOS 18.0 minimum.

## Studio deployment completed

| Component | Verified state |
|---|---|
| Dedicated Hermes desktop backend | Per-user LaunchAgent `com.dippo.hermes-mobile-backend`, loopback `127.0.0.1:9119`, existing Hermes home, private workspace |
| Bridge | Per-user LaunchAgent `com.dippo.hermes-mobile-bridge`, loopback `127.0.0.1:8787`, versioned installed runtime independent of checkout |
| Public-facing app URL within tailnet | `https://dippos-mac-studio.taildd4b84.ts.net` |
| Transport | Tailscale 1.102.2 Serve background HTTPS port 443; trusted TLS; no Funnel configuration |
| Application authentication | Missing/invalid credential → 401; read-only mutation → 403; authorized requests succeed |
| State/credentials | Private user-owned directories 0700 and config/credential files 0600, journal retained; mobile transfer token prepared but not displayed in tool output |
| Logs | Lifecycle-only JSON, 1 MiB per file plus two rotated backups per role; raw child output discarded; actual credential values absent from logs |
| Existing Hermes | Source and existing gateway supervisors unchanged; prior unrelated upstream dirty work preserved |

LaunchAgents start when the owning account logs in, restart crashed jobs, and stop on logout. Reboot/login and logout were **not physically exercised**. They do not offer pre-login availability. Current Studio power settings report `sleep 0`; no power settings were changed. See [Studio setup](docs/STUDIO_SETUP.md).

## Automated results

| Suite | Passed | Skipped / scope |
|---|---:|---|
| Swift unit/integration tests | 37 | 36 existing checks plus production HTTPS/Keychain inventory check in Simulator; two separate isolated-stack helpers skipped |
| Swift UI tests | 5 | Existing simulated UI tests; optional isolated-stack UI smoke skipped |
| Bridge pytest suite | 27 | All original 26, including installed-Hermes E2E, plus existing-session import regression |
| Deployment safety regressions | 8 | Private files, symlinks, failed-write preservation, active/unknown work guards, update rollback, Serve ownership |
| Physical iPhone tests | 0 | Blocked by absent connected/trusted phone and signing identity |

Commands: full `xcodebuild test` with ad-hoc Simulator signing and parallel testing disabled; final unit run additionally sets `TEST_RUNNER_HERMES_STUDIO_FIXTURE` to a private external fixture path. Bridge: `HERMES_BRIDGE_E2E=1 .../python -m pytest hermes-mobile-bridge/tests -q -s -p no:cacheprovider`. Deployment: `python3 scripts/test_studio_service.py -v`.

The initial optional HTTPS Simulator invocation used Xcode's parallel clone runner, which reported an IPC/server-died retry; it eventually succeeded. A sequential rerun passed the HTTPS check in 4.77 seconds. No physical or remote-peer result is inferred from it.

## Real Studio / Tailscale HTTPS checks

These used the actual private Serve hostname, normal certificate validation, scoped bearer authentication, production bridge and installed Hermes with the configured `gpt-5.6-luna` / `openai-codex` provider. They ran from the Studio and iOS Simulator, **not a physical phone**.

- Sessions/history listing, profiles, cron, Kanban `default`, usage and Home aggregation succeed.
- A repeated submission with the same idempotency key returned the same durable run ID.
- Real SSE opened over HTTPS, disconnected deliberately, and replayed retained events on reconnect. Journal sequences were ordered and unique; no command was restarted by stream reconnect.
- A safe live run completed with assistant deltas, one logical completed response, and a read-only `pwd` terminal call.
- A fresh run performing a bounded, read-only sleep accepted steering as `queued, consumed=false`. Stop acknowledged without claiming immediate termination; the subsequent run outcome was `cancelled`.
- Actual bridge child crash automatically recovered. Intentional bridge stop/restart recovered. Dedicated Hermes stop left the bridge authenticated and reachable with Hermes unhealthy and replay still available; backend restart recovered.
- Full start/stop and uninstall/reinstall were exercised. All **12 lifecycle assertions passed**, including retained credential, journal epoch, completed run ID and replay history. HTTPS was restored after reinstall.

The first cold run failed with Hermes's literal `agent initialization timed out` (`tui_gateway/server.py:890`, 30-second agent-ready limit). An explicit retry of the confirmed failed run completed; the subsequent fresh control-test conversation initialized and executed successfully. No upstream timeout was changed and no uncertain command was automatically resubmitted. Cold initialization after a restart remains a known reliability limitation to check on the phone.

A separate concrete bridge defect initially made imported session listings return 500 (`int(None)` for a new unowned record). The ownership flag now normalizes to a Boolean; a public endpoint regression confirms stable import IDs without executing a prompt. Production listings and the 27-test suite passed after the fix.

## Physical-phone checklist — all pending

| Area | Checks awaiting actual phone |
|---|---|
| Installation/signing | USB trust/unlock; Apple Account/Personal Team; Developer Mode; device install and launch |
| Pairing | Add Host → manual HTTPS URL + token; authenticated save; actual device Keychain retention after relaunch |
| Connection | Connect/disconnect/reconnect; foreground/background; Wi-Fi → cellular and cellular → Wi-Fi; Tailscale outage recovery |
| Chat | List/open/create sessions, send, streaming, tools, stable assistant message, no duplicate final bubble |
| Runs | Background active run, return/replay, steer, stop, completion while backgrounded |
| Status | Home, profiles/Bots, routines, Kanban, usage |
| Failures/cache | Bridge and Hermes outages/restarts, network outage, authentication failure, stale cache and recovery |
| Device UI | Safe areas, keyboard, scrolling, touch targets, truncation, Dynamic Type, navigation, banners, performance |
| SideStore | Installation, refresh, update over existing bundle, application data and Keychain preservation; VPN switching |

No device-specific UI fixes were made without on-device evidence. Tailscale ACL reachability from the phone, mobile-network handoff and simultaneous/alternating SideStore LocalDevVPN usage remain unverified.

## Release and exact next action

The unsigned device Release archive builds with zero compiler errors at `build/release/Hermes.xcarchive` (approximately 20 MiB). The bridge source archive and checksums are prepared under `build/release/`. **No IPA was produced**: the release script requires a real physical validation PASS report before SideStore packaging. No release was published or pushed.

Connect and unlock the iPhone by USB and accept **Trust This Computer**. Open `Hermes.xcodeproj`; in Xcode → Settings → Accounts sign in if needed, then Hermes target → Signing & Capabilities → select your **Personal Team**, preserving `com.dippo.hermes`. Enable Developer Mode if prompted and connect the phone's Tailscale app to the same tailnet. Installation/physical checks can proceed once Xcode sees the trusted device and can sign it.

When ready to pair, display the token only in a private terminal with `scripts/pairing-token.sh --show`. Enter it in the app; after verified Keychain storage, remove the transfer file using `--forget-transfer`. See [INSTALL](docs/INSTALL.md), [SideStore](docs/SIDESTORE.md) and [RELEASE](RELEASE.md).

The source repository is prepared for a GitHub push after review; release readiness remains blocked by physical/SideStore validation. No distribution license has been selected.
