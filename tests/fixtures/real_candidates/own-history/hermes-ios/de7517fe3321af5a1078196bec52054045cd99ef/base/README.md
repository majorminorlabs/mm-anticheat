# Talaria

Talaria is the native iPhone companion for Hermes running on your Mac Studio. The name comes from the winged sandals of Hermes. Hermes stays the agent and system being controlled; Talaria is the SwiftUI client that reaches it over
Tailscale through `hermes-mobile-bridge`. Production startup uses the configured Studio bridge. A separate built-in Simulation mode, previews and tests work without the Studio.

The Xcode project, scheme, targets and bundle identifier (`com.dippo.hermes`) keep their original Hermes names so installed app data, Keychain access and signing continuity are preserved; only the user-visible name is Talaria. Design language, brand usage and the relationship to Hermes Desktop are documented in [`TALARIA_DESIGN.md`](TALARIA_DESIGN.md).

## Run it

1. Open `Hermes.xcodeproj` in Xcode 26 or later.
2. Choose the **Hermes** scheme (it builds Talaria) and an iPhone simulator.
3. Press Run.

For a physical iPhone, follow [installation](docs/INSTALL.md) and [personal signing / SideStore](docs/SIDESTORE.md). The bundle ID remains `com.dippo.hermes`; no personal team or signing material is committed.

```sh
xcodebuild -project Hermes.xcodeproj -scheme Hermes \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
```

## Screenshots

`ScreenTourTests` and `DesignTourTests` walk every major screen against the mock backend. Pass `TEST_RUNNER_SCREENSHOT_DIR=/path` to save PNGs and `TEST_RUNNER_TOUR_APPEARANCE=dark` (or `light`) to capture an appearance:

```sh
TEST_RUNNER_SCREENSHOT_DIR=/tmp/talaria-shots TEST_RUNNER_TOUR_APPEARANCE=dark xcodebuild test \
  -project Hermes.xcodeproj -scheme Hermes -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -only-testing:HermesUITests/ScreenTourTests -only-testing:HermesUITests/DesignTourTests
```

## Simulation examples

- **Home:** shows four active runs, two approvals (one can be approved from the phone, one must be approved on the Studio), a blocked task and a failed routine.
- **Chat › Caddy:** approve or deny `rm generated-cache.json` and watch the run continue.
- **Chat › Researcher:** send an instruction to the running analysis, or stop it.
- **New chat:** a message containing "clean up" or "delete" triggers an approval.
- **More › Settings › Simulation:** simulate bridge offline, Hermes offline, sign-in required, slow or failing requests, an empty account, faster runs, or disabled capabilities.

## Docs

- [`TALARIA_DESIGN.md`](TALARIA_DESIGN.md): Talaria's visual system, brand mark, status language and its relationship to Hermes Desktop
- [`UI_ARCHITECTURE.md`](UI_ARCHITECTURE.md): navigation, state flow, models, services, components, mocks
- [`INTEGRATION_POINTS.md`](INTEGRATION_POINTS.md): implemented service mappings and remaining placeholders

## Real Studio bridge

The app now starts with `BridgeHermesClient`. A fresh install opens unpaired; it does not silently run mock data. Existing UI tests (`-uiTesting`) and SwiftUI previews still use mocks. Explicit Simulation mode in Settings takes effect after relaunch and uses separate hosts/preferences/cache; its controls never configure the real client.

1. Install existing Hermes at an audited commit (`2a4c9afd7bd` or `4bb9e57bfde8a0affb5553eff13ed6e1f14147f1`), including its Python environment. Run `scripts/install-bridge.sh --board default` as the Studio user. This installs two per-user LaunchAgents: a dedicated loopback Hermes desktop backend and the bridge. It preserves existing gateways and upstream source.
2. Run `scripts/configure-tailscale.sh`. It configures private **Tailscale Serve HTTPS**, never Funnel. The current Studio address is **https://dippos-mac-studio.taildd4b84.ts.net**. Restrict permitted tailnet peers; application authentication is still required.
3. Run `scripts/pairing-token.sh --name iPhone`, then `scripts/pairing-token.sh --show` in a private terminal when ready to pair. In Talaria, open More → Hosts → Add Host (or Add Host on the first-run Home screen) and enter a display name, the complete HTTPS URL and token. Save authenticates and selects it. Tokens live in device-only Keychain, never host records, UserDefaults, snapshots or logs. Manual pairing is V1; no QR enrollment service is exposed.
4. After successful pairing, run `scripts/pairing-token.sh --forget-transfer`. Pair Again opens the secure editor; an empty token preserves the Keychain item. Remove Local Credential forgets it on the phone. Revoke on Studio with `scripts/pairing-token.sh --revoke DEVICE_ID`; there is no mobile revocation endpoint.

Use `scripts/status-bridge.sh`, `start-bridge.sh`, `stop-bridge.sh`, `update-bridge.sh` and `uninstall-bridge.sh` from `scripts/`. Updates retain credentials and the run journal, refuse active/uncertain chat runs and pending mobile mutations, and roll back unhealthy runtimes. Services recover after crashes and start after login; they stop on logout and do not serve before login. Keep the Studio powered, awake and logged in. Logs contain bounded lifecycle records; raw child output is discarded to avoid leaking tokens or prompts.

See [Studio setup](docs/STUDIO_SETUP.md), [installation](docs/INSTALL.md), [release packaging](RELEASE.md), and [earlier deployment/device evidence](PHYSICAL_DEVICE_TEST_REPORT.md). Current physical-iPhone installation and Bot Mode evidence is recorded in [Bot Mode validation](BOT_MODE_VALIDATION.md). SideStore installation remains unvalidated.

See [API](BRIDGE_API.md), [Swift mappings](INTEGRATION_POINTS.md), [integration guide](IOS_INTEGRATION_GUIDE.md) and [validation report](INTEGRATION_TEST_REPORT.md).

### Simulator validation

Normal simulator use can pair to HTTPS exactly like a phone. Debug simulator builds additionally accept HTTP **only at loopback**; release/physical-device clients require HTTPS. No arbitrary cleartext exception or certificate bypass is introduced.

To run an isolated stack using the installed Hermes source and a deterministic local model (no production provider keys):

~~~sh
hermes-mobile-bridge/.venv/bin/python scripts/local_integration_stack.py /tmp/hermes-ios-stack
~~~

The script prints only its private fixture path and bridge port. Its directory is mode 0700, fixture/token/config files mode 0600. Keep it outside the repo. Hosted simulator tests read that fixture path and provision a temporary Keychain item; no token launch arguments/environment values are used. In another terminal:

~~~sh
TEST_RUNNER_HERMES_STACK_FIXTURE=/tmp/hermes-ios-stack/fixture.json xcodebuild test \
  -project Hermes.xcodeproj -scheme Hermes \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -only-testing:HermesTests/RealStackTests CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES
~~~

Run the opt-in production UI smoke next with the same `TEST_RUNNER_HERMES_STACK_FIXTURE` and `-only-testing:HermesUITests/RealStackUITests`. Hosted tests provision only the simulator's isolated host; remove Local Studio in Hosts when finished. To remove test pairing without navigating UI, run `TEST_RUNNER_HERMES_STACK_CLEANUP=1` with `-only-testing:HermesTests/RealStackTests/removeIsolatedSimulatorPairing`. Simulator Keychain tests require ad-hoc signing; disabling signing causes Keychain entitlement errors.

Terminate the fixture script to tear down only its test-owned services. The auxiliary restart/evidence listener is a test fixture on loopback, never a production bridge endpoint. Standard unit/UI tests require no Studio services. Bridge validation remains:

~~~sh
HERMES_BRIDGE_E2E=1 hermes-mobile-bridge/.venv/bin/python -m pytest hermes-mobile-bridge/tests -q
~~~

### Current limitations

Dangerous remote approval responses stay unavailable. Exact fresh clarification questions can be answered through the conversation composer. Stop is cooperative; unknown/lost outcomes remain explicit and never trigger a new execution. Cron Run Now advances due time and needs Hermes's scheduler. Kanban queueing needs its dispatcher. Native Bot Mode creation/editing/hiding and composer file/photo/camera uploads are available when advertised by the bridge. Voice dictation uses native iOS speech recognition. Memory contents, integrations and logs remain unavailable. Artifact metadata/download is restricted to bridge-registered files. APNs is deferred.

Run configuration is applied only when creating a conversation. Workspaces display administrator-chosen IDs; the phone cannot choose arbitrary Studio paths. Shared control with independent native desktop clients remains an upstream ownership limitation. Cursor retention expiry causes explicit snapshot resync. No physical-iPhone/Tailscale result is implied by loopback simulator testing.

## Release artifacts

`scripts/build-ios-release.sh` builds an unsigned device Release archive and a clean bridge source tarball with checksums under ignored `build/release/`. It does not embed Studio configuration or credentials. IPA production is gated on actual physical-device validation; see [RELEASE.md](RELEASE.md). Nothing is published automatically. No distribution license has been selected in this repository.

The optional Simulator HTTPS check uses a private mode-0600 JSON fixture outside the repository with `url` and `token` keys. It creates a temporary Keychain namespace and removes it after checking the real Studio inventories. Pass only the fixture path:

```sh
TEST_RUNNER_HERMES_STUDIO_FIXTURE=/private/path/studio-fixture.json xcodebuild test \
  -project Hermes.xcodeproj -scheme Hermes \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -only-testing:HermesTests/StudioTransportTests CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES
python3 scripts/test_studio_service.py -v
```

This confirms the iOS networking/Keychain path on Simulator, not physical-phone connectivity. Never commit the fixture or pass a token as a launch argument.


### Desktop Bot Mode

The Bots tab can discover the Studio Desktop roster dynamically, including the default Hermes identity once, and display each bot's actual enabled skills and configuration. Enable the private backend's `bot_mode_roster` grant (or `install-bridge.sh --bot-mode` on a new install). Tap Chat to open a writable persistent canonical Bot Chat; absent chats initialize on that tap. Enable the separate private `bot_chat_control` grant (or `install-bridge.sh --bot-chat` on a new install). Bot identity and native model/SOUL/skills are preserved, and Chat and Bots open the same conversation. Bot creation/editing/hiding uses the native Desktop lifecycle with an additional `bot_mode_management` grant (`install-bridge.sh --bot-management` for new installs). See [bot management](BOT_MANAGEMENT.md) and [attachments and voice](ATTACHMENTS_AND_VOICE.md). See [source audit](BOT_MODE_AUDIT.md) and [validation evidence](BOT_MODE_VALIDATION.md).

Files, PhotosPicker, native camera capture and editable speech-to-text are wired
into the existing composer. See [ATTACHMENTS_AND_VOICE.md](ATTACHMENTS_AND_VOICE.md)
for limits and permissions. The PostgreSQL Research Terminal search delivery is
preserved in [the scoped patch bundle](patches/research-terminal-postgres-search/README.md),
because that separate checkout already had unrelated staged migration work.
