# Install Hermes for iPhone

Hermes for iPhone is a native client. Hermes Agent and the mobile bridge run on the Mac Studio; the phone connects to the bridge over your tailnet. The bridge does not replace Hermes and does not connect through SSH.

## Requirements

- A Mac Studio with the audited Hermes installation and its desktop API available to a dedicated local backend.
- macOS, Python 3.11 or newer, and Tailscale signed in to the same tailnet as the iPhone.
- Tailscale MagicDNS and HTTPS enabled for the tailnet. Tailscale Serve also needs the phone-to-Studio connection allowed by the tailnet access policy.
- An iPhone running iOS 18 or newer, and an installation route: Xcode with a signed-in Apple ID for development, or SideStore for repeatable personal-device installs.

The checked-in bundle identifier is `com.dippo.hermes` and the app version is `0.1.0`. Installation requires your own Apple signing identity; no signing certificate or provisioning profile is included.

## Mac Studio

Clone this repository on the Studio, then install the bridge for the macOS account that owns the Hermes installation:

```sh
git clone <repository-url> ~/src/hermes-ios
cd ~/src/hermes-ios
./scripts/install-bridge.sh
```

The installer creates a versioned bridge runtime and virtual environment under `~/Library/Application Support/HermesMobileBridge`, separate from both the source checkout and Hermes's Python environment. It keeps service configuration, bridge state, upstream token files, and generated mobile credentials in that private service root. Logs go to `~/Library/Logs/HermesMobileBridge`. It installs per-user LaunchAgents for the bridge and a dedicated Hermes desktop backend process.

The defaults use Hermes source `~/.hermes/hermes-agent`, the existing Hermes home `~/.hermes`, a private workspace beneath the service root, bridge loopback port 8787, and desktop backend loopback port 9119. The installer checks that the Hermes source is the audited `2a4c9afd7bd` commit. The separate backend process serves that selected Hermes home; it does not replace existing Hermes gateways. Override the source/home/workspace or ports during installation if your Studio uses different locations:

```sh
./scripts/install-bridge.sh \
  --hermes-source "$HOME/.hermes/hermes-agent" \
  --workspace "$HOME/Projects/my-workspace"
```

Use `--board NAME` for each Kanban board to expose. Review the installer summary before accepting it. The dedicated backend must use the audited Hermes checkout and have exclusive ownership of its configured chat transport. Existing Hermes gateways are left in place and unchanged.

Configure HTTPS through Tailscale Serve and check the service:

```sh
./scripts/configure-tailscale.sh
./scripts/status-bridge.sh
```

The configured Studio URL is `https://dippos-mac-studio.taildd4b84.ts.net`. Confirm it matches the Studio's current MagicDNS name before pairing. Tailscale Serve proxies HTTPS on port 443 to the bridge at `127.0.0.1:8787`; the bridge remains bound to loopback and requires its own mobile bearer token.

Create a device credential. The default command provisions a scoped token without printing it:

```sh
./scripts/pairing-token.sh --name iPhone
```

Follow the command's private-provisioning instructions. The helper keeps the token in a mode-0600 `mobile-pairing.json` file until you remove the transfer copy or revoke it. When the app's Add Host flow asks for the token, display it in a private terminal:

```sh
./scripts/pairing-token.sh --show
```

Copy it directly into the iPhone app; do not put it in shell history, a file in the checkout, chat, screenshots, or logs. The app stores it in Keychain. After pairing, remove the separate protected plaintext transfer copy with `./scripts/pairing-token.sh --forget-transfer`; the token remains valid in the app. The bridge's credential database stores only the credential hash and registry metadata. If the token is exposed, revoke its device ID with `./scripts/pairing-token.sh --revoke DEVICE_ID`, then provision a replacement.

## iPhone

1. Install and sign in to Tailscale on the iPhone. Confirm the Studio and phone are members of the same tailnet.
2. Install Hermes using Xcode or SideStore. See [SideStore installation](SIDESTORE.md) for personal-device signing and update steps.
3. Open Hermes → More → Hosts → Add Host.
4. Enter a name such as `Mac Studio`, the HTTPS bridge URL, and the one-time displayed mobile token. Saving checks authentication and stores the token in the iPhone Keychain.
5. Open Home and confirm that both the bridge and Hermes report healthy.

Use the full HTTPS URL shown by `configure-tailscale.sh`. Do not enter the Studio's loopback bridge URL, a raw HTTP URL, an SSH address, or a Hermes provider key.

### Direct Xcode installation

For development, connect and unlock the iPhone, accept its Trust This Computer prompt, and open the project in Xcode. Under the **Hermes** target's **Signing & Capabilities**, select your Apple Account's **Personal Team** and leave automatic signing enabled. Preserve `com.dippo.hermes`; select the connected iPhone as the run destination and press **Run**. Xcode requires an Apple Account sign-in, but a paid Developer Program membership is not required for personal-device testing. Apple's Personal Team provisioning is temporary: registered App IDs/devices and development profiles expire after seven days, so the app must be rebuilt/reinstalled periodically. [Apple account and Personal Team limits](https://developer.apple.com/help/account/basics/about-your-developer-account) · [Installing on personal devices with Xcode](https://developer.apple.com/help/account/membership/program-enrollment).

## Service controls and updates

Run these commands from the repository checkout:

```sh
./scripts/status-bridge.sh
./scripts/stop-bridge.sh
./scripts/start-bridge.sh
./scripts/update-bridge.sh
./scripts/uninstall-bridge.sh
```

The update command installs the checked-out bridge source into a new versioned runtime while retaining the service's private configuration, credentials, run journal and logs. It refuses to update while an active or uncertain run may be controlled. Stop or reconcile that work in the app/Studio first, then retry. Uninstall removes the LaunchAgents and installed runtime but retains configuration and state by default. Use `./scripts/uninstall-bridge.sh --purge` only when you deliberately want to erase the retained service data and device credentials too.

For full Studio service, backup, and network details, read [Studio setup](STUDIO_SETUP.md). For development builds and simulator tests, see the root [README](../README.md).

## Current installation limits

The bridge and Hermes LaunchAgents start when the owning user logs in and are kept alive after crashes. They stop at logout; they do not run before login as root services. The Mac must be powered, awake, logged into the configured account, and connected to Tailscale for iPhone access. This is an intentional per-user service design so the processes use the normal Hermes configuration without system-wide privileges.

Pairing is manual host URL plus token. There is no QR enrollment endpoint in bridge v0.1.0. Physical iPhone behavior depends on the actual tailnet policy, Apple signing, and device network; the repository's local Simulator results do not establish those outcomes.
