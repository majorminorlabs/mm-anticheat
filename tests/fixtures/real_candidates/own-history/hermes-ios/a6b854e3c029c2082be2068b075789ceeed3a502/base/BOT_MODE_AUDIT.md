# Bot Mode mobile milestone — 2026-10-03

## Source and identity

Audited installed Hermes Agent commit: `4bb9e57bfde8a0affb5553eff13ed6e1f14147f1`
(`0.21.5+6627.g4bb9e57`), checkout `/Users/dippo/.hermes/hermes-agent`.
The running Desktop application is from that checkout's
`apps/desktop/release/mac-arm64/Hermes.app`. Its backend launch contract is
`hermes serve`, JSON-RPC over authenticated WebSocket, with REST for inventory
and persisted transcripts. The previously running mobile backend predated the
source update and did not implement `profiles.list`/`profiles.describe`.

Bot Mode is a **specialized profile layer plus Desktop presentation metadata**,
not a separate bot database. There is a first-class internal RPC contract that
was missing from the previous mobile audit. The bridge normalizes that contract;
Swift never reads host files or resolves profile paths.

| Field | Canonical source at the audited commit |
| --- | --- |
| Local roster and profile IDs | `tui_gateway/methods_profiles.py`, `profiles.list`; `hermes_cli/profiles.py::list_profiles`; live named-profile predicate in `hermes_constants.py::named_profile_is_live` |
| Name | `apps/desktop/src/plugins/hermes-bots/labels.ts::displayName`: server `profile.yaml` → `ui_meta['hermes-bots'].title`, then `display_name`, then Hermes for `default`, then formatted profile ID |
| Description | Bot Mode metadata description, then profile description; `profiles.describe` editor snapshot |
| Role | Backend permission role only when supplied; research/general categories are not inferred from names |
| Avatar | `profiles.list.has_avatar`, `profiles.get_asset {name,asset:'avatar'}` → bounded image data URL; absent shapes/local-only decorations retain a monogram |
| Last activity | `canonical_session` and `last_session`; Desktop helper `data.ts::botActivitySession` selects the fresher of those two; bridge also includes a more recent persisted worker session |
| Live working/idle | Not globally confirmed by this dedicated backend. V1 labels unobserved status or persisted last-active time instead of guessing Idle. Other Desktop processes' live event ownership remains incomplete |
| Canonical conversation | `(profile, title == 'Bot Chat')`; `methods_session.py::session.list {profile,title,include_hidden:true}` resolves by exact title, following the compression tip. No saved session ID or newest-chat fallback |
| Transcript | Profile-scoped REST `/api/sessions/{resolved_id}/messages`, normalized into the existing iOS Conversation/Message types |
| Model/provider, SOUL, skills, toolsets, MCP | `profiles.describe {name}` in `methods_profiles.py`; `config.yaml`, `SOUL.md`, installed `SKILL.md` indexes, `skills.disabled`, configured CLI toolsets, MCP names/enabled/transport |
| Routines | Profile-scoped REST `/api/cron/jobs`; name/enabled/timestamps/status metadata only |
| Memory | Profile-scoped REST `/api/memory`: active provider, provider metadata and allowlisted builtin byte counts; no contents or file paths |
| Agent plugins | Read-only `plugins.manage {profile,action:'list'}` from `methods_tools.py`; only name/enabled cross the mobile boundary |
| Config metadata | `profiles.describe.toolsets_pinned` and source attribution; no raw config, environment variables, provider keys, endpoint secrets, filesystem path APIs |

Desktop also retains window-local cosmetic/pinning/unread state in plugin storage
(`data.ts`, `profile-ops.ts::mergeServerMeta`). The mobile contract uses persisted
server metadata, not Electron local storage. Hidden bots (`hermes-bots.hidden`)
are omitted. Deleted/tombstoned/non-live profiles disappear with the next roster
read. Archiving a chat is different from hiding/deleting its bot; it does not
remove the profile. Hermes may repair accidentally archived canonical chats as
part of its own lookup; the bridge adds no repair/creation operation.

The default profile and the Hermes roster entry are the same identity. It is
included once in Bots, with no separate Default Profile section. Two distinct
profiles with the same display name remain distinct; names are not identity keys.

## Mobile API and authorization

- `GET /mobile/v1/bots`: freshly discovered roster, opaque IDs, source attribution,
  bounded activity metadata and canonical-chat availability.
- `GET /mobile/v1/bots/{id}`: fresh per-bot detail/configuration inventory.
- `GET /mobile/v1/bots/{id}/conversation`: resolve the canonical title on every
  request and return its current real transcript. Stable mobile routing ID
  `botchat.<bot-id>` identifies the relationship, not a pinned Hermes session ID.
- Existing `/profiles`, conversation/run controls, authentication and profile
  allowlists remain compatible.
- `features.profiles` and `features.botMode` are separate. A backend advertises
  Bot Mode only after its RPC handshake verifies `bot_mode_protocol:true`.
  Older backends fall back to generic profiles.

Opt in with `backends.<source>.bot_mode_roster: true` in the private bridge config,
or `install-bridge.sh --bot-mode` for a new installation. This explicitly grants
credentials that can read that backend's profile access to its **entire local
Desktop bot roster, including future bots**. It is a read-only roster grant;
existing generic profile control permissions are not broadened. An unconfigured
backend or one outside the credential allowlist cannot be selected through an
opaque bot ID. Do not opt a source into an audience that should see only one bot.

The production client uses the bot resources when Bot Mode exists. Simulation
fixtures remain isolated. Names in tests represent sanitized Studio fixtures;
production code does not contain the three Studio bot names.

## Refresh and chat behavior

Opening Bots starts a fresh fetch and a cancellable 15-second refresh while that
screen is visible. Pull to refresh, app foreground and successful reconnect also
refresh the roster. Each response replaces membership, so new profiles appear
and removed/hidden profiles disappear without rebuilding. Detail refreshes every
15 seconds while visible; roster refresh preserves loaded detail fields until a
fresh detail response replaces them. Refresh remains request-based; V1 does not
claim full Desktop change-event coverage.

Chat opens the existing canonical transcript in the normal Conversation view,
read-only, with manual refresh. It does not `session.resume`, rebind a Desktop
session event sink, run an intro, or create any conversation. No canonical row →
Chat is disabled with a Studio-initialization explanation. Composition, rename,
delete and run controls are not offered for imported Bot Chats. Ordinary
bridge-owned conversations retain their existing controls.

## Later create/edit work

Desktop's underlying mechanism is available but intentionally not exposed here:
`profiles.create`, `profiles.configure` (SOUL/description/model/provider,
disabled_skills/enabled_toolsets/enabled_mcp_servers), `profiles.set_asset`, and
profile delete/rename operations. Bot creation also needs Desktop's adopt-before-
minting exact-title chat flow, hidden initialization and intro behavior. Editing
requires safe handling of `applied` partial successes, model-cost confirmation,
and `ui_meta_expected_revisions` compare-and-swap. Delete/archive must distinguish
profile deletion from hidden roster metadata and chat archival, protect active
turns and preserve history intentionally. Sending into Desktop Bot Chats needs a
separately audited shared-ownership or delivery protocol. None is added in V1.

## Verification and Studio/device evidence

See `BOT_MODE_VALIDATION.md` for completed results, discovered Studio identities,
physical-device evidence and remaining limits. Source investigation and fixtures
must be distinguished from actual physical-phone validation.
