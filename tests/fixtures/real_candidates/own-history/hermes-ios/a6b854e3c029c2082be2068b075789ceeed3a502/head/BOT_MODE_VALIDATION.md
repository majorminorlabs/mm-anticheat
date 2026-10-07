# Writable Bot Chat validation — 2026-10-03

This milestone continues `28a5f59` on `codex/bot-mode-milestone`. Nothing was
pushed or published. Canonical lifecycle/source details are in
[BOT_MODE_AUDIT.md](BOT_MODE_AUDIT.md).

## Result and Studio deployment

One Chat tap on a visible bot now opens a writable persistent native canonical
`Bot Chat`, initializing a missing row with Hermes Desktop's hidden,
profile-following, eager-title lifecycle. No intro/model turn is sent during
initialization. Both Bots and main Chat return the same mobile conversation ID;
no generic default-profile chat is created as a fallback.

The existing guarded updater deployed the bridge after isolated validation.
Private configuration and existing SQLite databases were backed up using SQLite's
backup API under the private installation root's `bot-chat-backups/20261003-152906`.
The `default` source now explicitly grants `bot_mode_roster:true` and
`bot_chat_control:true`. Credentials, journal and the existing private Tailscale
HTTPS route were preserved. Both dedicated services are healthy and advertise
Bot Mode, writable Bot Chat and modern clarifications. Installed Hermes remains
`4bb9e57bfde8a0affb5553eff13ed6e1f14147f1`.

| Bot | Native profile | Actual model/provider | Canonical result |
| --- | --- | --- | --- |
| Hermes | `default` | `gpt-5.6-luna` / `openai-codex` | Initialized from phone; message completed |
| Research Orchestrator | `research-orchestrator` | `gpt-6.1-sol` / `openai-codex` | Initialized from phone; message/tools completed; history reopened |
| Research Worker | `research-worker` | `gpt-5.6-luna` / `openai-codex` | Initialized/opened from phone; no production message requested |

Authenticated HTTPS reads and direct read-only source database checks confirmed
exactly one hidden `Bot Chat` row per profile and matching Bots/Chat IDs. All three
retain separate canonical identities and persistent source transcripts.
Live bridge records show one canonical mobile relationship for each. Exact-title
lookup is refreshed on opens/reads; the source root/tip relationship is checked.
Hidden/removed membership fails safely without deleting history or minting a
replacement. Source profile configuration remains native; no bot names/models
are hardcoded in production code.

## Physical iPhone results

The signed app was installed on the connected iPhone 15 Pro Max using local
signing settings and the phone's existing pairing. Actual XCTest actions exercised:

- **Research Orchestrator:** Bot detail, visibly hittable `research-terminal` skill
  row, enabled Chat, initialization/open, send, streamed response and tool activity.
  The run completed with 71 `assistant.delta` events and two started/completed
  tools: `skill_view` for the attached native-profile skill, then the Research
  Terminal helper's read-only `search "Hermes"`. The skill result identifies the
  actual `research-orchestrator` skill directory; this is source execution evidence,
  not a UI identity label. Actual session metadata retained `gpt-6.1-sol` and
  `openai-codex`.
- **Recovery:** background/home and foreground, termination/relaunch, reopen via
  Bots, then open from main Chat with the same response/history. Screenshots retain
  the streaming/tool panel and the reopened transcript. The live bridge relationship
  and stable conversation ID were independently checked.
- **Hermes:** initialize/open, safe identity-only send, streamed assistant response
  and completion (16 deltas). No tools were requested.
- **Research Worker:** initialize/open writable canonical chat, screenshot; no
  production model execution was requested for this bot.

All three distinct physical tests passed across the initial Hermes/Worker run and
corrected Orchestrator rerun. The first Orchestrator attempt failed only its skill
traversal assertion: full-page swipes skipped the row and reached the long SOUL
section. Short overlapping collection-view drags corrected the test. No message
was sent in that failed attempt. Initial lock/toolchain readiness and a test-target
signing-team requirement were resolved before execution; they are not app defects.

**Research Terminal environment limitation:** the read-only helper returned exit
code 1, `RESEARCH_TERMINAL_API_TOKEN_FILE is required`. The assistant accurately
reported that no search results/source title were returned. The chat, native skill
access, tool invocation and streaming paths succeeded, but successful Research
Terminal retrieval is not claimed. No credential inspection, research job creation,
publication, external message or destructive research operation was performed.
The missing Research Terminal authentication reference was not changed in this pass.

Ignored local evidence: `build/bot-chat-validation/` contains sanitized live run
metadata and phone screenshots, including `attached-research-terminal-on-iphone.png`,
`mobile_research_check_done.png`, `research-orchestrator-history-after-relaunch.png`
and `same-bot-chat-opened-from-chat-tab.png`. Result bundles:

- `/tmp/hermes-botchat-device/Logs/Test/Test-Hermes-2026.10.03_15-31-15--0500.xcresult`
  (Hermes/Worker passed; initial skill traversal failed).
- `/tmp/hermes-botchat-device/Logs/Test/Test-Hermes-2026.10.03_15-36-00--0500.xcresult`
  (corrected Orchestrator, passed).

## Automated validation

- **Bridge: 42 passed, 0 skipped/failed**, with `HERMES_BRIDGE_E2E=1`.
  Ten new canonical lifecycle/protocol regressions cover absence, reuse, concurrent
  taps, eager title failure/retry, native send/profile identity, same CID in main
  Chat, hidden/removed history retention, authorization/configuration gates,
  mismatched registry roots/profiles, busy native turns and modern clarification.
- **Installed-source end-to-end:** an isolated Hermes home and deterministic local
  model, with no production provider credentials. Concurrent initialization of all
  three identities, distinct native model/SOUL/skills, source history, same-CID list,
  tools, stop/steer, two-question clarification after transport reconnect, replay,
  bridge restart and cold Hermes restart all passed. Cold Orchestrator execution
  again proved its native model/SOUL/skill context. Process loss leaves the interrupted
  generic run unknown and never resends its prompt.
- **Studio lifecycle/configuration: 8 passed.**
- **Full Swift unit/UI: 46 passed, 10 explicitly skipped, 0 failed; 56 total.**
  Optional physical/isolated-stack/Studio tests are skipped unless explicitly enabled.
  Includes 26 BridgeIntegrationTests and existing simulation UI coverage. Result:
  `/tmp/hermes-botchat-final/Logs/Test/Test-Hermes-2026.10.03_15-26-31--0500.xcresult`.
- Signed physical build/install succeeded. `git diff --check` passed.

Logs: `/tmp/hermes-botchat-bridge-all.log`, `/tmp/hermes-botchat-service.log`,
`/tmp/hermes-botchat-swift-all.log`, `/tmp/hermes-botchat-device-orchestrator.log`.
No token/configuration/signing material is added to repository artifacts.

## Dynamic discovery and deliberately deferred work

Existing fresh roster/15-second visible refresh/foreground/reconnect behavior is
preserved. Automated tests exercise new membership, hidden/removed membership and
preserved historical rows without an app rebuild. The earlier read-only milestone's
Studio-owned temporary probe discovery/removal evidence remains historical; it was
not repeated with a production probe in this pass.

Bot creation/editing, profile deletion/archive, model/SOUL/skill configuration UI,
rooms and destructive approval responses remain deferred. Independent Desktop
clients can attach to the same source session; the bridge does not claim exclusive
per-client ownership or full observation of Desktop-created runs. Modern source
clarification locks still permit cross-client races before the batch settles.
Phone stop/steer and clarification actions were not physically exercised here;
they passed bridge, Swift and actual installed-Hermes isolated tests.

## Signing reconciliation

The pre-existing project/scheme changes were inspected and kept unchanged locally,
excluded from this milestone. Parsing the project as property-list objects confirms
its only semantic changes are personal `DEVELOPMENT_TEAM` assignments in the app's
Debug and Release settings; the remaining diff is serializer ordering. The shared
scheme's existing removal of UI-test `parallelizable="NO"` is also left uncommitted.
Test-target signing was supplied via a local `xcodebuild DEVELOPMENT_TEAM=…` override.
No personal team assignment, device ID, certificate, provisioning profile, Apple
credential or secret is committed. This preserves the user's existing local signing
work while keeping the shared project portable.
