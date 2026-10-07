# Install Hermes with SideStore

This guide covers a personal install of Talaria, the iPhone client for Hermes. Talaria talks to the Studio bridge over its configured HTTPS/Tailscale address; SideStore does not provide that connection.

## Install SideStore once

SideStore currently documents a macOS first-install path using `iloader`. Have an iPhone with a passcode, a Mac with Wi-Fi, and an Apple Account available. Follow the current [SideStore prerequisites](https://docs.sidestore.io/docs/installation/prerequisites) and [installation guide](https://docs.sidestore.io/docs/installation/install) because supported iOS steps can vary by OS release.

1. Install LocalDevVPN and connect it as SideStore’s guide requires for app installation and refresh.
2. Download and open the current stable `iloader` release from the link in SideStore’s prerequisites.
3. Connect the iPhone to the Mac by USB, unlock it, enter the passcode, and accept **Trust This Computer** on the phone if prompted.
4. In iloader, sign in to the Apple Account to use for SideStore, select the phone, and install **SideStore (Stable)**.
5. On the phone, trust the Developer App under **Settings → General → VPN & Device Management**. On iOS versions that require it, enable **Developer Mode** under **Settings → Privacy & Security** and allow the restart.
6. Connect LocalDevVPN, open SideStore, sign in with the same Apple Account, and refresh SideStore from **My Apps** to finish setup.

With a free Apple Account, SideStore’s development signing expires after seven days; that account is limited to three installed apps at a time and ten App IDs in a seven-day period. SideStore requires LocalDevVPN when installing, updating, or refreshing apps. See the [SideStore FAQ](https://docs.sidestore.io/docs/faq) for current limits and paid-account details.

## Install Hermes

Create a SideStore package only after the physical-device checks are recorded as passing. The release script requires `physical_device_validation: PASS` in the validation report before it writes an IPA:

```sh
scripts/build-ios-release.sh \
  --sidestore-ipa \
  --physical-validation-report PHYSICAL_DEVICE_TEST_REPORT.md
```

Transfer `build/release/Hermes.ipa` to the phone using a trusted method such as AirDrop or Files. In SideStore, import/sideload that IPA using the app’s current import flow. SideStore re-signs installed apps with the Apple Account’s development identity. The IPA produced here is a standard `Payload/Hermes.app` archive without a developer’s embedded signing profile or signature.

Launch Hermes, add the Studio host using its stable Tailscale HTTPS URL, and enter the bridge token once. The app stores that token in the iOS Keychain. The bridge token is not part of the IPA.

## Updating Hermes

Build a new IPA using the same `com.dippo.hermes` bundle identifier, then install the new IPA over the existing app through SideStore. **Do not delete the installed app first.** SideStore says that sideloading the same or updated IPA this way should retain app data, but this repository has not yet verified data preservation on the target iPhone. The app’s Keychain token may need to be paired again if the signing identity or Keychain access group changes.

Keep SideStore refreshed before its signing period expires. Its current guidance requires LocalDevVPN during install, update, and refresh; the VPN is a SideStore maintenance path, separate from the Tailscale connection Talaria uses to reach the Studio. If switching to LocalDevVPN disconnects Tailscale, reconnect Tailscale before using Talaria. VPN switching on the target phone remains unverified.

## Current validation status

SideStore installation and update-in-place have not yet been tested on the target phone. Do not treat a simulator build, Xcode device build, or unsigned IPA layout check as physical SideStore validation. First record the actual phone, iOS version, Xcode installation, pairing and run/reconnect checks in `PHYSICAL_DEVICE_TEST_REPORT.md`. That physical Xcode validation enables IPA packaging; SideStore installation and data-preservation checks follow using the generated IPA and must be recorded separately.
