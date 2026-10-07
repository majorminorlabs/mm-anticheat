import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import {
  conciergeCategories,
  conciergeEventTypes,
  type ConciergeEvent,
} from "@/lib/concierge/types";
import { redactUnansweredQuery } from "@/lib/concierge/matcher";

export const runtime = "nodejs";

const MAX_BODY_LENGTH = 16_384;
const MAX_EVENTS = 12;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 60;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

const eventTypeSet = new Set<string>(conciergeEventTypes);
const categorySet = new Set<string>(conciergeCategories);
const confidenceSet = new Set(["high", "medium", "low"]);

function boundedString(value: unknown, maxLength: number) {
  if (typeof value !== "string") return undefined;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[<>]/g, "")
    .trim();
  return cleaned ? cleaned.slice(0, maxLength) : undefined;
}

function safeId(value: unknown) {
  const cleaned = boundedString(value, 100);
  return cleaned && /^[a-zA-Z0-9._:-]+$/.test(cleaned) ? cleaned : undefined;
}

function safePath(value: unknown) {
  const cleaned = boundedString(value, 240);
  return cleaned?.startsWith("/") && !cleaned.includes("?") ? cleaned : undefined;
}

function safeIsoDate(value: unknown) {
  const cleaned = boundedString(value, 40);
  return cleaned && Number.isFinite(Date.parse(cleaned)) ? cleaned : undefined;
}

function safeMetadata(value: unknown): ConciergeEvent["metadata"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const metadata = value as Record<string, unknown>;
  const result: ConciergeEvent["metadata"] = {
    openedOnPath: safePath(metadata.openedOnPath),
    landingPath: safePath(metadata.landingPath),
    referrerHost: boundedString(metadata.referrerHost, 120),
    utmSource: boundedString(metadata.utmSource, 100),
    utmMedium: boundedString(metadata.utmMedium, 100),
    utmCampaign: boundedString(metadata.utmCampaign, 100),
    utmContent: boundedString(metadata.utmContent, 100),
    utmTerm: boundedString(metadata.utmTerm, 100),
  };
  return Object.values(result).some(Boolean) ? result : undefined;
}

function validateEvent(value: unknown): ConciergeEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  const type = boundedString(event.type, 40);
  const eventId = safeId(event.eventId);
  const sessionId = safeId(event.sessionId);
  const occurredAt = safeIsoDate(event.occurredAt);
  const pagePath = safePath(event.pagePath);
  const knowledgeVersion = safeId(event.knowledgeVersion);

  if (!type || !eventTypeSet.has(type) || !eventId || !sessionId || !occurredAt || !pagePath || !knowledgeVersion) {
    return null;
  }

  const category = boundedString(event.category, 40);
  const confidence = boundedString(event.confidence, 10);
  const matchScore =
    typeof event.matchScore === "number" && Number.isFinite(event.matchScore)
      ? Math.max(0, Math.min(100, Math.round(event.matchScore)))
      : undefined;
  const unanswered =
    type === "query_unanswered"
      ? redactUnansweredQuery(boundedString(event.normalizedQuery, 240) || "")
      : undefined;

  return {
    eventId,
    sessionId,
    occurredAt,
    type: type as ConciergeEvent["type"],
    pagePath,
    knowledgeVersion,
    questionId: safeId(event.questionId),
    entryId: safeId(event.entryId),
    category: categorySet.has(category || "")
      ? (category as ConciergeEvent["category"])
      : undefined,
    confidence: confidenceSet.has(confidence || "")
      ? (confidence as ConciergeEvent["confidence"])
      : undefined,
    matchScore,
    linkId: safeId(event.linkId),
    normalizedQuery: unanswered?.normalizedQuery,
    redactionReason:
      type === "query_unanswered"
        ? unanswered?.redactionReason || safeId(event.redactionReason)
        : undefined,
    summary: type === "session_ended" ? boundedString(event.summary, 500) : undefined,
    metadata: type === "session_started" ? safeMetadata(event.metadata) : undefined,
  };
}

function requestFingerprint(request: Request) {
  const source = `${request.headers.get("x-forwarded-for") || "unknown"}|${request.headers.get("user-agent") || "unknown"}`;
  return createHash("sha256").update(source).digest("hex").slice(0, 24);
}

function isRateLimited(request: Request) {
  const now = Date.now();
  if (rateBuckets.size > 5_000) {
    for (const [key, value] of rateBuckets) {
      if (value.resetAt <= now) rateBuckets.delete(key);
    }
    while (rateBuckets.size > 5_000) {
      const oldestKey = rateBuckets.keys().next().value as string | undefined;
      if (!oldestKey) break;
      rateBuckets.delete(oldestKey);
    }
  }
  const fingerprint = requestFingerprint(request);
  const bucket = rateBuckets.get(fingerprint);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(fingerprint, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT;
}

function isSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin) return origin === new URL(request.url).origin;
  const fetchSite = request.headers.get("sec-fetch-site");
  return fetchSite === "same-origin";
}

function readWebhookUrl() {
  const configured = process.env.CONCIERGE_EVENTS_WEBHOOK_URL?.trim();
  if (!configured) return undefined;
  try {
    const url = new URL(configured);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ message: "Cross-origin requests are not accepted." }, { status: 403 });
  }
  if (isRateLimited(request)) {
    return NextResponse.json({ message: "Too many requests." }, { status: 429 });
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return NextResponse.json({ message: "JSON is required." }, { status: 415 });
  }

  const body = await request.text();
  if (!body || body.length > MAX_BODY_LENGTH) {
    return NextResponse.json({ message: "Invalid request size." }, { status: 413 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return NextResponse.json({ message: "Invalid JSON." }, { status: 400 });
  }

  const values =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as { events?: unknown }).events
      : undefined;
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_EVENTS) {
    return NextResponse.json({ message: "Invalid event batch." }, { status: 400 });
  }

  const events = values.map(validateEvent);
  if (events.some((event) => event === null)) {
    return NextResponse.json({ message: "Invalid event." }, { status: 400 });
  }

  const webhookUrl = readWebhookUrl();
  if (!webhookUrl) return new NextResponse(null, { status: 204 });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Data-Retention-Days": "90",
        ...(process.env.CONCIERGE_EVENTS_WEBHOOK_TOKEN
          ? { Authorization: `Bearer ${process.env.CONCIERGE_EVENTS_WEBHOOK_TOKEN}` }
          : {}),
      },
      body: JSON.stringify({ events }),
      signal: controller.signal,
    });
    if (!response.ok) console.error("Concierge event sink rejected a batch", response.status);
  } catch (error) {
    console.error(
      "Concierge event sink failed",
      error instanceof Error ? error.name : "UnknownError",
    );
  } finally {
    clearTimeout(timeout);
  }

  return new NextResponse(null, { status: 204 });
}
