# Changelog

Changes relevant to users of Talaria (the iPhone client for Hermes) and the Studio bridge.

## Unreleased — Talaria design pass

- Renamed the iPhone client to **Talaria** (display name, Home title, About, permission prompts). Hermes keeps its name; the bundle identifier stays `com.dippo.hermes`.
- New app icon from the canonical winged-sandal mark; the mark appears in About, the first-run welcome and the pairing sheet.
- Adopted Hermes Desktop's visual language: one blue accent, flat surfaces, small tags, quiet section labels, and Desktop's bot faces in the roster, chat list and conversations.
- Raw backend reasons (`hermes_execution_error`, `upstream_disconnected`, …) now read as plain language, with the code under Details.
- Conversations hide the tab bar so the composer owns the bottom edge; tool history collapses into one group; the composer pairs mic and send and shows a clear listening state.
- Bot detail is ordered identity → Chat → activity → configuration → skills → management; Create/Edit Bot moves skills, toolsets and MCP into searchable pages.
- See [TALARIA_DESIGN.md](TALARIA_DESIGN.md).

## 0.1.0 — 2026-10-02

- Added the native SwiftUI iPhone client with Simulation mode and a production client for `hermes-mobile-bridge`.
- Added the Studio bridge API for sessions, durable runs and replay, profiles, scheduled jobs, Kanban, Home aggregation, usage, inventory, and registered artifacts.
- Added bearer-token pairing with device-scoped revocation; the iOS app stores bridge credentials in Keychain.
- Added bridge, Hermes health, and reconnect state handling, while keeping Hermes execution and persistent records on the Studio.
- Kept remote dangerous tool approvals unavailable because Hermes does not guarantee exact-target approval semantics.
- Added per-user launchd installation, controlled lifecycle logs, start/stop/status/update/uninstall, guarded updates and retained-state reinstall.
- Configured and exercised private Tailscale Serve HTTPS with application authentication on the Studio.
- Added unsigned Release archive/bridge source packaging and a physical-validation gate before SideStore IPA generation.
- Fixed importing previously unseen Hermes sessions into the bridge.
- Physical iPhone installation and SideStore updates remain pending device-specific Apple signing and phone access.

This changelog describes repository features. It does not assert that a physical iPhone, SideStore package, has been validated. Studio deployment and HTTPS results are recorded separately. See [the integration test report](INTEGRATION_TEST_REPORT.md) for the completed local validation and [the physical device report](PHYSICAL_DEVICE_TEST_REPORT.md) for this deployment pass's device status.
