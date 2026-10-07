import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/concierge/events/route";

const endpoint = "https://home-watch.test/api/concierge/events";

function validEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventId: "event-1",
    sessionId: "session-1",
    occurredAt: "2026-07-12T12:00:00.000Z",
    type: "query_matched",
    pagePath: "/plans-pricing",
    knowledgeVersion: "2026-07-12.1",
    ...overrides,
  };
}

function request(
  body: string,
  headers: Record<string, string> = {},
) {
  return new Request(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://home-watch.test",
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    body,
  });
}

describe("concierge event API validation", () => {
  beforeEach(() => {
    delete process.env.CONCIERGE_EVENTS_WEBHOOK_URL;
    delete process.env.CONCIERGE_EVENTS_WEBHOOK_TOKEN;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.CONCIERGE_EVENTS_WEBHOOK_URL;
    delete process.env.CONCIERGE_EVENTS_WEBHOOK_TOKEN;
  });

  it("accepts a minimal valid event", async () => {
    const response = await POST(
      request(JSON.stringify({ events: [validEvent()] })),
    );

    expect(response.status).toBe(204);
  });

  it("rejects cross-origin requests", async () => {
    const response = await POST(
      request(JSON.stringify({ events: [validEvent()] }), {
        "content-type": "application/json",
        origin: "https://attacker.test",
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      message: "Cross-origin requests are not accepted.",
    });
  });

  it("rejects requests without a same-origin browser signal", async () => {
    const response = await POST(
      new Request(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: [validEvent()] }),
      }),
    );

    expect(response.status).toBe(403);
  });

  it("requires a JSON content type", async () => {
    const response = await POST(
      request(JSON.stringify({ events: [validEvent()] }), {
        "content-type": "text/plain",
      }),
    );

    expect(response.status).toBe(415);
  });

  it.each([
    ["", 413, "Invalid request size."],
    ["x".repeat(16_385), 413, "Invalid request size."],
    ["{not-json", 400, "Invalid JSON."],
    [JSON.stringify({ events: [] }), 400, "Invalid event batch."],
    [JSON.stringify({ events: Array.from({ length: 13 }, () => validEvent()) }), 400, "Invalid event batch."],
  ])("rejects an invalid body or batch", async (body, status, message) => {
    const response = await POST(request(body));

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ message });
  });

  it.each([
    ["unknown event type", { type: "unknown" }],
    ["unsafe event ID", { eventId: "event id" }],
    ["missing session ID", { sessionId: undefined }],
    ["invalid timestamp", { occurredAt: "not-a-date" }],
    ["external page URL", { pagePath: "https://attacker.test/path" }],
    ["query-bearing path", { pagePath: "/pricing?secret=true" }],
    ["unsafe knowledge version", { knowledgeVersion: "version with spaces" }],
  ])("rejects an event with %s", async (_label, overrides) => {
    const response = await POST(
      request(JSON.stringify({ events: [validEvent(overrides)] })),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ message: "Invalid event." });
  });

  it("sanitizes, bounds, and forwards fields allowed for an unanswered query", async () => {
    process.env.CONCIERGE_EVENTS_WEBHOOK_URL = "https://events.test/sink";
    process.env.CONCIERGE_EVENTS_WEBHOOK_TOKEN = "secret-token";
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      request(
        JSON.stringify({
          events: [
            validEvent({
              type: "query_unanswered",
              category: "storm-watch",
              confidence: "high",
              matchScore: 140.6,
              questionId: "question-1",
              entryId: "storm-overview",
              linkId: "storm-link",
              normalizedQuery: `storm\u0000 ${"x".repeat(300)}`,
              redactionReason: "pii-removed",
              summary: "must-not-forward",
              metadata: {
                openedOnPath: "/storm-watch",
                landingPath: "/?private=query",
                referrerHost: `source.test\u0000${"x".repeat(200)}`,
                utmSource: "campaign",
                ignoredField: "not-forwarded",
              },
            }),
          ],
        }),
      ),
    );

    expect(response.status).toBe(204);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://events.test/sink");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer secret-token",
    });
    const forwarded = JSON.parse(String(init.body)).events[0];
    expect(forwarded).toMatchObject({
      category: "storm-watch",
      confidence: "high",
      matchScore: 100,
      questionId: "question-1",
      entryId: "storm-overview",
      linkId: "storm-link",
      redactionReason: "pii-removed",
    });
    expect(forwarded.normalizedQuery).toHaveLength(180);
    expect(forwarded.normalizedQuery).not.toContain("\u0000");
    expect(forwarded.summary).toBeUndefined();
    expect(forwarded.metadata).toBeUndefined();
  });

  it("only forwards session context on session-started events", async () => {
    process.env.CONCIERGE_EVENTS_WEBHOOK_URL = "https://events.test/sink";
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await POST(
      request(
        JSON.stringify({
          events: [
            validEvent({
              type: "session_started",
              normalizedQuery: "must not forward",
              metadata: {
                openedOnPath: "/storm-watch",
                landingPath: "/?private=query",
                referrerHost: `source.test\u0000${"x".repeat(200)}`,
                utmSource: "campaign",
                ignoredField: "not-forwarded",
              },
            }),
          ],
        }),
      ),
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const forwarded = JSON.parse(String(init.body)).events[0];
    expect(forwarded.normalizedQuery).toBeUndefined();
    expect(forwarded.metadata).toMatchObject({
      openedOnPath: "/storm-watch",
      utmSource: "campaign",
    });
    expect(forwarded.metadata.landingPath).toBeUndefined();
    expect(forwarded.metadata.referrerHost).toHaveLength(120);
    expect(forwarded.metadata.ignoredField).toBeUndefined();
  });

  it("only forwards a bounded summary on session-ended events", async () => {
    process.env.CONCIERGE_EVENTS_WEBHOOK_URL = "https://events.test/sink";
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await POST(
      request(
        JSON.stringify({
          events: [validEvent({ type: "session_ended", summary: "s".repeat(700) })],
        }),
      ),
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const forwarded = JSON.parse(String(init.body)).events[0];
    expect(forwarded.summary).toHaveLength(500);
  });

  it("redacts sensitive unanswered text again on the server", async () => {
    process.env.CONCIERGE_EVENTS_WEBHOOK_URL = "https://events.test/sink";
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await POST(
      request(
        JSON.stringify({
          events: [
            validEvent({
              type: "query_unanswered",
              normalizedQuery: "the code to the lock box is 1234",
            }),
          ],
        }),
      ),
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const forwarded = JSON.parse(String(init.body)).events[0];
    expect(forwarded.normalizedQuery).toBeUndefined();
    expect(forwarded.redactionReason).toBe("sensitive-access-details");
  });

  it("does not forward events to a non-HTTPS sink", async () => {
    process.env.CONCIERGE_EVENTS_WEBHOOK_URL = "http://events.test/sink";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      request(JSON.stringify({ events: [validEvent()] })),
    );

    expect(response.status).toBe(204);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("omits invalid optional enum values and rounds valid scores", async () => {
    process.env.CONCIERGE_EVENTS_WEBHOOK_URL = "https://events.test/sink";
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await POST(
      request(
        JSON.stringify({
          events: [
            validEvent({
              category: "not-a-category",
              confidence: "certain",
              matchScore: 47.6,
            }),
          ],
        }),
      ),
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const forwarded = JSON.parse(String(init.body)).events[0];
    expect(forwarded.matchScore).toBe(48);
    expect(forwarded.category).toBeUndefined();
    expect(forwarded.confidence).toBeUndefined();
  });
});
