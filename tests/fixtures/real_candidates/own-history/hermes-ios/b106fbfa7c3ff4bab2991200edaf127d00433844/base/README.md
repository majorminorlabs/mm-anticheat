# Hermes for iPhone

A native SwiftUI client for Hermes Agent running on a Mac Studio, reached over
Tailscale through `hermes-mobile-bridge`. Production startup uses the configured Studio bridge. A separate built-in Simulation mode, previews and tests work without the Studio.

## Run it

1. Open `Hermes.xcodeproj` in Xcode 26 or later.
2. Choose the **Hermes** scheme and an iPhone simulator.
3. Press Run.

To run on a device, set your team under Signing & Capabilities. The bundle ID
is `com.dippo.hermes`.

```sh
xcodebuild -project Hermes.xcodeproj -scheme Hermes \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
```

## Simulation examples

- **Home:** shows four active runs, two approvals (one can be approved from the phone, one must be approved on the Studio), a blocked task and a failed routine.
- **Chat › Caddy:** approve or deny `rm generated-cache.json` and watch the run continue.
- **Chat › Researcher:** send an instruction to the running analysis, or stop it.
- **New chat:** a message containing "clean up" or "delete" triggers an approval.
- **More › Settings › Simulation:** simulate bridge offline, Hermes offline, sign-in required, slow or failing requests, an empty account, faster runs, or disabled capabilities.

## Docs

- [`UI_ARCHITECTURE.md`](UI_ARCHITECTURE.md): navigation, state flow, models, services, components, mocks
- [`INTEGRATION_POINTS.md`](INTEGRATION_POINTS.md): implemented service mappings and remaining placeholders

## Real Studio bridge

The app now starts with `BridgeHermesClient`. A fresh install opens unpaired; it does not silently run mock data. Existing UI tests (`-uiTesting`) and SwiftUI previews still use mocks. Explicit Simulation mode in Settings takes effect after relaunch and uses separate hosts/preferences/cache; its controls never configure the real client.

1. Install/configure the Studio package using [bridge setup](hermes-mobile-bridge/README.md). Each configured Hermes profile requires its own exclusive desktop backend. Keep the bridge state directory across restarts.
2. Provision a scoped mobile token through the Studio bridge CLI. Configure HTTPS through your intended Tailscale hostname/proxy and restrict tailnet access. This implementation does not deploy or expose a production service automatically.
3. In More → Hosts → Add Host, enter a display name, complete bridge HTTPS URL and the mobile token. Save authenticates and selects it. Tokens are stored in device-only Keychain, never saved host records, UserDefaults, snapshots or logs.
4. Pair Again opens the same secure editor. Editing with an empty token preserves the Keychain item. Remove Local Credential forgets it on the phone; revoke the Studio credential using `token-revoke DEVICE_ID` on Studio. There is no mobile revocation endpoint.

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

Dangerous remote approval responses stay unavailable. Exact fresh clarification questions can be answered through the conversation composer. Stop is cooperative; unknown/lost outcomes remain explicit and never trigger a new execution. Cron Run Now advances due time and needs Hermes's scheduler. Kanban queueing needs its dispatcher. Profiles/skills are read-only; memory contents, integrations, logs, camera, voice and uploads are not exposed in this pass. Artifact metadata/download is restricted to bridge-registered files. APNs is deferred.

Run configuration is applied only when creating a conversation. Workspaces display administrator-chosen IDs; the phone cannot choose arbitrary Studio paths. Shared control with independent native desktop clients remains an upstream ownership limitation. Cursor retention expiry causes explicit snapshot resync. No physical-iPhone/Tailscale result is implied by loopback simulator testing.
