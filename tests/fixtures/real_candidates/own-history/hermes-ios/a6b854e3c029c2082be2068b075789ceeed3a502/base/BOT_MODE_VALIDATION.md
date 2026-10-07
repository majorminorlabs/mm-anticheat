# Bot Mode validation — 2026-10-03

Source audit and API/authorization details: [BOT_MODE_AUDIT.md](BOT_MODE_AUDIT.md).
This milestone is on `codex/bot-mode-milestone`. Nothing was pushed or published.
Pre-existing Xcode project/scheme signing changes are excluded from the milestone.

## Studio deployment and actual data

The dedicated bridge backend now runs installed Hermes commit
`4bb9e57bfde8a0affb5553eff13ed6e1f14147f1` using Hermes's managed runtime,
not the stale legacy venv. Both that commit and the previous audited commit
`2a4c9afd7bd` are accepted. The bridge was updated through the existing guarded
update script. Private configuration and SQLite databases were backed up via
SQLite's backup API before deployment. Device credentials, the bridge journal,
and the existing Tailscale HTTPS route were preserved.

The default source is explicitly opted into read-only whole-roster Bot Mode.
Authenticated live API checks returned these three identities:

| Bot | Profile identity | Model/provider | Canonical Bot Chat |
| --- | --- | --- | --- |
| Hermes | `default` | `gpt-5.6-luna` / `openai-codex` | Not initialized |
| Research Orchestrator | `research-orchestrator` | `gpt-6.1-sol` / `openai-codex` | Not initialized |
| Research Worker | `research-worker` | `gpt-5.6-luna` / `openai-codex` | Not initialized |

Live detail requests returned SOUL and avatars, enabled skills, memory/plugin
metadata, and empty routine lists. The Orchestrator's enabled skill inventory
contains all six requested names: `research-terminal`, `arxiv`,
`hermes-bluebubbles-operations`, `llama-cpp`, `llm-wiki`, and
`online-price-comparison`. Its live inventory contains many additional skills;
the six-item fixture is a sanitized test sample, not the complete live inventory.
The Worker includes `research-terminal-worker`. Cross-process live working/idle
state remains unobserved; persisted last-active times are displayed.

No canonical chat was created, resumed or rebound in the production profiles.
Chat remains disabled until the Studio initializes its canonical Bot Chat.
Existing canonical history and exact-title lookup are validated in an isolated
actual-Hermes fixture with a temporary home and local model, without production
profiles or provider keys. Moving compressed tips are covered by the bridge wire
fixture and verified against the installed lookup implementation. Imported Bot Chats are
read-only; composition requires a later shared-ownership audit.

## Dynamic discovery

On the running Studio, a uniquely named temporary profile displayed as
`Mobile Refresh Probe` was added using the source's profile storage contract.
A fresh authenticated bridge request immediately returned four bots. Setting
its persisted Bot Mode `hidden` metadata removed it from the roster. The owned
temporary directory was then deleted, and the next request returned exactly the
original three bots. No service restart or app rebuild was involved. No model
execution, provider credential, routine or canonical conversation was created.
Cleanup succeeded; no probe remains.

The phone fetches on opening Bots, foreground, reconnect and pull to refresh,
plus every 15 seconds while the view is active. Each result replaces membership;
details refresh on the same interval. Automated Swift and bridge fixtures cover
new identities, removal/hiding, reconnect, legacy-profile fallback, duplicate
Hermes/default prevention and production data isolation.

## Physical iPhone

The signed app was built and installed successfully on the connected iPhone 15
Pro Max (`Scott’s iPhone`, bundle `com.dippo.hermes`), using the existing local
signing configuration. No signing material is committed.

The initial physical UI run confirmed all three names in Bots and no separate
Default Profile section. It opened Research Orchestrator and loaded its actual
Studio skill inventory. A screenshot of the three-bot roster is retained locally
under ignored `build/bot-mode-validation/iphone-bots.png`.

That run failed its `research-terminal` assertion because eight scrolls did not
reach the skill in the large live list. The failure's accessibility hierarchy
contains real skill rows through the middle of that inventory. The test was
corrected to allow thirty scrolls and to select the detail Chat button explicitly.
Subsequent physical runs could not start because the iPhone was locked.
Consequently, **physical confirmation of the specific `research-terminal` row
and temporary-bot appearance/removal remains unverified**. The bridge API and
isolated tests confirm those data/discovery paths, but they do not substitute for
on-device evidence. Canonical Chat cannot be opened on this Studio snapshot
because no canonical row exists; the app deliberately does not create one.

## Automated checks

- Bridge suite with installed-Hermes integration enabled: **32 passed**.
- Studio service lifecycle/configuration suite: **8 passed**.
- Full Swift unit/UI suite: **44 passed, 7 explicitly skipped, 0 failed**
  (`/tmp/hermes-bots-tests-final-source.xcresult`, 51 total).
- After the final canonical-chat model-label correction, the complete unit suite
  was rerun: **39 passed, 3 explicitly skipped, 0 failed**
  (`/tmp/hermes-bots-unit-final.xcresult`, 42 total).
- Signed physical `build-for-testing`: succeeded; final app installation succeeded.
- `git diff --check`: passed.

Local test logs and result bundles live under `/tmp/hermes-bots-*`; credentials
and private configuration are excluded. Optional physical/local-stack tests are
explicitly skipped in the normal simulator suite, rather than counted as passes.

## Deferred controls

Bot creation/editing, SOUL changes, model/provider changes, skill toggles and
profile deletion/archive are intentionally not added. The source RPCs and their
required concurrency, partial-success, cost and canonical-chat initialization
handling are documented in the source audit. Older generic profile APIs remain
available; unavailable fields receive no fabricated values.
