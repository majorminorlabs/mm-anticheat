# Release packaging

The app bundle identifier is `com.dippo.hermes`; the current app and bridge version is `0.1.0`. Keep that bundle identifier for updates so iOS and SideStore recognize the same app. The Xcode project does not contain a personal Team ID or signing certificate.

Before release cleanup, consult [Talaria post-design regression validation](TALARIA_REGRESSION_VALIDATION.md). It records the accessibility table fix, 69 Swift passes with 21 explicit opt-in skips, affected follow-up checks, screenshot evidence and successful post-design physical acceptance. Talaria is ready for v0.1.0 release cleanup; no release has been published. Personal signing and scheme changes remain machine-local. See [current release readiness](docs/RELEASE_READINESS.md) for generated artifacts, privacy checks and outstanding SideStore/history gates.

## Build the device archive

On macOS with the project’s Xcode toolchain installed:

```sh
scripts/build-ios-release.sh
```

This builds a Release `Talaria-v0.1.0.xcarchive` with code signing disabled, packages the tracked bridge runtime and service files, and writes output beneath `build/release/`. Xcode’s temporary DerivedData is placed outside the repository and removed when the build ends. The default command does not create an IPA.

To create a SideStore import package after physical device validation, the report must include the exact line `physical_device_validation: PASS`:

```sh
scripts/build-ios-release.sh \
  --sidestore-ipa \
  --physical-validation-report PHYSICAL_DEVICE_TEST_REPORT.md
```

That produces `build/release/Talaria-v0.1.0.ipa`, an unsigned `Payload/Hermes.app` package for SideStore to sign during installation, plus `SHA256SUMS.txt`. The script checks the bundle identifier and verifies that the SideStore package contains neither an embedded provisioning profile nor a code-signature directory. The report gate records human validation; it does not cryptographically attest to a device test.

SideStore applies its own development signing identity to apps that it installs and refreshes. A free Apple Account has a seven-day provisioning window and other app limits; see [Apple’s Personal Team limits](https://developer.apple.com/help/account/basics/about-your-developer-account) and the [SideStore FAQ](https://docs.sidestore.io/docs/faq).

For direct Xcode installation, sign in under **Xcode → Settings → Accounts**, connect and unlock the iPhone, accept its trust prompt, and select it as the run destination. In the project editor, select the **Hermes** app target → **Signing & Capabilities**, leave **Automatically manage signing** enabled, and choose your **Personal Team**. Keep `com.dippo.hermes` as the bundle identifier. Xcode can register the connected device and create the development profile; press **Run** to install. A Personal Team profile expires after seven days, so rebuild and reinstall after it expires. Apple documents this flow in [Running your app on a physical device](https://developer.apple.com/documentation/xcode/running-your-app-on-simulated-or-physical-devices) and the [developer account overview](https://developer.apple.com/help/account/basics/about-your-developer-account).


Keep signing machine-local: copy `Config/Signing.example.xcconfig` to the ignored root `Signing.local.xcconfig` and set `DEVELOPMENT_TEAM` to your Team ID from Xcode. The shared project loads it optionally. Selecting a Team in Xcode can write the project file; keep that personal change uncommitted. Release packaging overrides the Team and signing identity to blank.

## Bridge source package

The build script invokes `scripts/package-bridge.sh`. The bridge tarball contains tracked bridge runtime source, example configuration, API contracts, launchd plist, and Studio install/update scripts. It excludes tests, virtual environments, caches, logs, databases, private configuration, and local signing material. The packager fails if any required installation or service file is untracked or missing. Commit the release scripts, launchd plist, and setup documents before creating a release archive.

For a standalone bridge source package:

```sh
scripts/package-bridge.sh --output-dir build/release
```

It writes `hermes-mobile-bridge-v0.1.0.tar.gz` and a sibling `.sha256` file. Verify a standalone bridge package from its output directory with:

```sh
cd build/release
shasum -a 256 -c hermes-mobile-bridge-v0.1.0.tar.gz.sha256
```

The full release build writes `SHA256SUMS.txt` for the bridge archive and, when enabled, the IPA.

Do not add signing certificates, provisioning profiles, bridge tokens, private Studio configuration, or Hermes/provider credentials to a release. Do not publish artifacts until the physical-device validation report records the completed checks.

The Studio source package includes an explicit README, installation, usage, optional Research Terminal and troubleshooting guides. Tar ownership/timestamps are normalized; release compilation remaps private source/debug paths. Run `python3 scripts/test_release_artifacts.py -v` and `scripts/audit-release-artifacts.py` against outputs before sharing. Preserve Git history, but review its old blobs separately: cleaning the current tree does not sanitize prior commits.
