# Local research search router

The local pipeline expands a selected pitch through a bounded research router
before it drafts. Search finds URLs. The existing local fetcher retrieves and
extracts the selected pages. They are intentionally separate operations.

## Setup

Copy the search variables from [`.env.example`](../.env.example) into the
controller's environment. All provider keys are optional. The router checks
the local cache first, then uses direct known sources, Brave, Exa, Tavily, and
finally the low-volume browser-search fallback. Missing keys only remove that
provider from the route.

Keep provider accounts on their free tiers with auto-recharge and paid
overages disabled. `RESEARCH_PAID_USAGE_ALLOWED=false` is the default, and
the router independently enforces per-query, per-article, and page limits.

## Cache and auditing

`pipeline-state/research-cache.json` is an ignored local cache. News results
expire after six hours, general results after seven days, and academic results
after thirty days. Each research packet stores `search_usage` and
`search_warnings`, including provider request totals, cache hits, fetched-page
count, and whether a local budget was reached.

The browser fallback uses a public HTML results page only after configured
providers are unavailable or coverage remains weak. It is deliberately
low-volume and does not render JavaScript-heavy pages. The existing local page
fetcher remains the normal retrieval layer. Firecrawl is not required and is
reserved for a future optional extractor adapter.

## Verify without spending credits

Run mocked router tests only:

```sh
npm test -- --test-name-pattern='research router'
```

Run the full local suite:

```sh
npm test
npm run lint
```

No live provider calls are made by either test command.
