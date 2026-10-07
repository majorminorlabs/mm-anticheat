# Editorial taxonomy

## Discovery Coverage Focus

Coverage Focus is the pre-discovery subject area used to choose eligible
sources. The active registry offers All Web3 sources, Digital Collectibles,
DeFi, Markets, Chains, Products, and Culture. All uses every eligible Web3
Source Graph feed; the newsroom defaults to All Web3 sources, while
compatibility API requests that omit `focus_id` use All Web3 sources. Staged X
accounts and unactivated feeds remain out of discovery.

Coverage Focus is separate from the editorial taxonomy applied after retrieval:

| Field | Meaning |
| --- | --- |
| Coverage Focus | The broad subject area discovery should search. |
| Primary Lens | The editorial question or perspective applied to a selected story. |
| Story Form | The format, reporting depth, and length contract for the story. |
| Beat | A recurring coverage category attached to a story. |
| Topic | The specific subject of an individual story. |

Source membership lives in the Web3 `source_registry`; a source can belong to
several primary sections, which become its discovery focuses. The controller
reads only eligible feed records at run time. `pipeline-state/sources.json` is
an intentionally credential-free local-development fallback. The batch stores
its selected focus, so retries use the original value rather than the editor's
later browser preference.

Anyways is organized as Lens → Section → Beat → Topic. Every story has one
primary lens, one optional section, zero or more recurring beats, and optional
specific topics.

## Lenses

| Slug | Editorial question |
| --- | --- |
| `internet` | How does online culture shape the real world? |
| `systems` | How do complicated and influential things actually work? |
| `taste` | Why do people want what they want? |
| `media` | How do ideas, attention, and influence spread? |

## Recurring beats

`ai`, `music`, `brands`, `cities`, `fashion`, `subcultures`, `design`,
`architecture`, `food`, `sports`, `automotive`, `gaming`, `film-tv`, `retail`,
`travel`, and `luxury` are controlled subjects that can occur inside any lens.
They do not appear in primary navigation.

Topics are narrow, flexible descriptors such as `Claude`, `ticketing`, or
`young founders`. They are neither lenses nor beats.

## Sections and reporting depth

The optional Section sets the reader's expected commitment and the evidence
needed to earn it. It does not replace the editorial lens.

| Section | Target | Range | Minimum retained sources | Contract |
| --- | ---: | ---: | ---: | --- |
| Meanwhile... | 350 | 250–500 | 3 | Quick observation with one memorable detail and a visual opportunity. |
| While You’re Here | 700 | 500–900 | 5 | Side story with two or three concrete examples and a surprising detail. |
| Worth Your Time | 900 | 700–1,100 | 6 | Recommendation or profile with multiple cases and a primary source. |
| Receipts | 1,400 | 1,100–1,800 | 10 | Document-driven reporting with primary documents and sourced major claims. |
| Anyways... | 1,500 | 1,200–2,000 | 10 | Signature feature with reporting, competing views where available, and an original insight. |
| We Read It So You Don’t Have To | 900 | 700–1,200 | 6 | A report or filing distillation anchored to the underlying document. |

The pipeline fails closed when the selected section lacks its source floor or
the draft falls outside its range. It must not pad a story to hit a target.

## Classification gate

Choose the lens by why the piece matters, then choose the optional section and
add beats for what it covers. A pitch should satisfy at least two significance
tests: it changes capability, desire, power, attention, online-to-offline
behavior, how something is built, or a reader's understanding of the modern
world. Commodity announcements, press releases, unexamined trends, and
celebrity updates do not qualify alone.

Technology coverage must connect to human capability or daily life. Music
coverage must explain fandom, reputation, law, money, culture, identity, or
the industry rather than imitate celebrity gossip.

## Legacy conversion

Existing records retain their stored identifiers. The UI maps retired lens and
section values to the nearest canonical display value without a destructive
migration. Existing migration files remain immutable historical records.
