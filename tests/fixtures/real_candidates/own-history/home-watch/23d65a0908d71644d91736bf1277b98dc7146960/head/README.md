# Mobile Bay Home Watch

Next.js App Router site for Mobile Bay Home Watch, a Mobile Bay home watch and
coastal property oversight service.

## Development

```bash
npm run dev
npm run lint
npm run test
npm run build
```

The lead form posts to `/api/lead` for bounded server-side validation and sends
through Resend. `RESEND_API_KEY` is required for successful submissions.
`LEAD_WEBHOOK_URL` can additionally forward the validated lead to a private CRM
or capture endpoint.

## Home Watch Concierge

The persistent concierge is a local deterministic question-and-answer tool. It
does not call an LLM or external AI service. Its versioned, typed content lives
in `src/lib/concierge/knowledge-base.ts`; normalization, urgent routing,
exclusions, scoring, confidence thresholds, and privacy redaction live in
`src/lib/concierge/matcher.ts`. The public panel is loaded only after its
launcher is first opened.

Aggregate concierge events use the existing environment-gated GA4 integration.
Privacy-reduced private events post to `/api/concierge/events`, which validates,
rate-limits, and optionally forwards them when these server-only variables are
set:

```bash
CONCIERGE_EVENTS_WEBHOOK_URL=https://private-event-sink.example/ingest
CONCIERGE_EVENTS_WEBHOOK_TOKEN=replace-with-a-long-random-token
```

The sink should deduplicate by `eventId`, enforce the requested 90-day retention
for event-level records and unanswered queries, and expose authenticated
reporting/CSV export outside this public website. Add a Vercel Firewall rate
rule for `/api/concierge/events` in production; the included in-process limiter
is defense in depth, not a globally durable serverless rate limit.

No public or first-party admin route is included because this repository has no
authentication system. A Home Watch OS dashboard or another authenticated event
destination is the intended analytics viewing surface.
