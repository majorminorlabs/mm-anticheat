# Hermes Bot management from iPhone

Bot Mode uses Hermes profiles as its source of truth. The bridge calls the same
profile RPCs used by Hermes Desktop and never writes profile files itself:

- `profiles.create` creates a normal Hermes profile, cloning the host's
  `default` profile as Desktop does. It shares the host auth pool; no provider
  credentials are returned to the phone.
- `profiles.configure` updates the profile description, `SOUL.md`, model pin,
  installed-skill selection, configured toolsets/MCP servers, and the Bot Mode
  display title in `profile.yaml` metadata.
- `profiles.describe` and `profiles.list` read the saved values back before the
  bridge reports success. Profile identity is the native Hermes profile name;
  changing the display title never renames that identity or changes its chat.
- Hiding sets `ui_meta['hermes-bots'].hidden`. It only removes a bot from the
  Bot Mode roster. The Hermes profile and canonical `Bot Chat` history remain.
  Unhide clears that flag. The default profile cannot be hidden.

The phone supplies a display title. The bridge derives a Unicode-aware Hermes
profile slug, checks it against all profiles including hidden ones, and lets
Hermes enforce its own reserved-name and creation rules. Description is the
Hermes profile description, not the separate Hermes permission role. Model and
provider must be a pair present in that backend's live model inventory. Skill,
toolset, and MCP selections are restricted to entries Hermes already reports
for the target profile; this interface does not install skills, configure MCP
commands, or edit arbitrary profile files.

The live inventory is available as `GET /mobile/v1/bots/inventory`. Pass
`profile=<authorized backend>` for creation inventory. Pass `bot_id=<opaque bot
ID>` to retrieve that bot's profile-specific installed capabilities for edit.
Inventory entries contain selector metadata only; provider credentials, API
keys, base URLs, MCP commands, environment values, and filesystem paths are
excluded.

## Capability and permission gates

Mutations require all of the following:

- The mobile credential has `read` and `chat.control` for the backend.
- The backend grants `bot_mode_roster: true` and the separate
  `bot_mode_management: true` in its private bridge configuration.
- The connected Hermes backend advertises the Bot Mode protocol and is running
  the audited `4bb9e57bfde8a0affb5553eff13ed6e1f14147f1` lifecycle contract.

The bridge reports per-backend `botCreate`, `botEdit`, `botHide`, and
`botInventory` capabilities. Older or disconnected backends return these as
unavailable so clients can hide management controls. Bot Chat access alone
does not enable profile mutation.

Hermes may require a confirmation before applying a guarded model change. The
bridge returns that confirmation requirement without reporting the model as
saved; a client should show Hermes' message and retry only after the user
confirms. A successful edit is re-read from Hermes and returned to the client.

## Deletion and history

Mobile deletion is not exposed. Hermes' native `profile delete` permanently
removes the profile, stops its gateway and related backends, removes the
profile's files, and settles its persisted identity. Hiding is the supported
reversible action and preserves canonical chats. A future delete action would
need a separate confirmation that explains these Hermes semantics.

## Diagnostics

If management controls are absent, inspect `GET /mobile/v1/capabilities` for
the backend and check the two private bridge grants, Hermes connection state,
the negotiated `bot_mode_protocol`, and the installed Hermes commit. If a save
returns an error, reopen or refresh the bot detail to see the values Hermes
actually stored. Do not repair a failed edit by writing `profile.yaml`,
`config.yaml`, or `SOUL.md` from the phone.
