"use client";

import { CONCIERGE_KNOWLEDGE_VERSION } from "@/lib/concierge/types";
import type {
  ConciergeEvent,
  ConciergeHandoff,
} from "@/lib/concierge/types";

const SESSION_KEY = "mbhw.concierge.session.v1";
const HANDOFF_KEY = "mbhw.concierge.handoff.v1";
const HANDOFF_MAX_AGE_MS = 30 * 60 * 1000;
let memorySession: SessionContext | undefined;

type SessionContext = {
  sessionId: string;
  startedAt: string;
  landingPath: string;
  referrerHost?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
};

function cleanMetadata(value: string | null, maxLength = 100) {
  return value?.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maxLength) || undefined;
}

function readReferrerHost() {
  if (!document.referrer) return undefined;
  try {
    return new URL(document.referrer).hostname.slice(0, 120) || undefined;
  } catch {
    return undefined;
  }
}

function createSession(): SessionContext {
  const params = new URLSearchParams(window.location.search);
  return {
    sessionId: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    landingPath: window.location.pathname.slice(0, 240),
    referrerHost: readReferrerHost(),
    utmSource: cleanMetadata(params.get("utm_source")),
    utmMedium: cleanMetadata(params.get("utm_medium")),
    utmCampaign: cleanMetadata(params.get("utm_campaign")),
    utmContent: cleanMetadata(params.get("utm_content")),
    utmTerm: cleanMetadata(params.get("utm_term")),
  };
}

export function getConciergeSession(): SessionContext {
  if (memorySession) return memorySession;
  try {
    const stored = sessionStorage.getItem(SESSION_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as SessionContext;
      if (parsed.sessionId && parsed.startedAt && parsed.landingPath) {
        memorySession = parsed;
        return parsed;
      }
    }
  } catch {
    // Storage can be unavailable in private contexts. A memory-only session is fine.
  }

  const session = createSession();
  memorySession = session;
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // Answers and navigation do not depend on storage.
  }
  return session;
}

function safePath(path?: string) {
  const value = path || window.location.pathname;
  return value.startsWith("/") ? value.slice(0, 240) : "/";
}

function gaEventName(type: ConciergeEvent["type"]) {
  const names: Partial<Record<ConciergeEvent["type"], string>> = {
    concierge_opened: "concierge_open",
    suggestion_selected: "concierge_suggestion",
    query_matched: "concierge_answer",
    query_unanswered: "concierge_unanswered",
    answer_link_clicked: "concierge_link_click",
    phone_clicked: "concierge_phone_click",
    contact_clicked: "concierge_contact_click",
    contact_form_submitted: "concierge_lead_submit",
  };
  return names[type];
}

export function recordConciergeEvent(
  event: Omit<ConciergeEvent, "eventId" | "sessionId" | "occurredAt" | "knowledgeVersion">,
  options: { beacon?: boolean } = {},
) {
  const session = getConciergeSession();
  const payload: ConciergeEvent = {
    ...event,
    pagePath: safePath(event.pagePath),
    eventId: crypto.randomUUID(),
    sessionId: session.sessionId,
    occurredAt: new Date().toISOString(),
    knowledgeVersion: CONCIERGE_KNOWLEDGE_VERSION,
  };

  const eventName = gaEventName(payload.type);
  if (eventName) {
    window.gtag?.("event", eventName, {
      entry_id: payload.entryId,
      question_id: payload.questionId,
      category: payload.category,
      confidence: payload.confidence,
      source_path: payload.pagePath,
      link_id: payload.linkId,
    });
  }

  const body = JSON.stringify({ events: [payload] });
  if (options.beacon && navigator.sendBeacon) {
    navigator.sendBeacon(
      "/api/concierge/events",
      new Blob([body], { type: "application/json" }),
    );
    return;
  }

  void fetch("/api/concierge/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => {
    // The deterministic answer path never waits for analytics.
  });
}

export function createContactHandoff(entryId?: string): ConciergeHandoff {
  const session = getConciergeSession();
  const handoff: ConciergeHandoff = {
    sessionId: session.sessionId,
    entryId,
    sourcePath: window.location.pathname.slice(0, 240),
    openedAt: new Date().toISOString(),
    landingPath: session.landingPath,
    referrerHost: session.referrerHost,
    utmSource: session.utmSource,
    utmMedium: session.utmMedium,
    utmCampaign: session.utmCampaign,
    utmContent: session.utmContent,
    utmTerm: session.utmTerm,
  };
  try {
    sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(handoff));
    window.setTimeout(() => {
      try {
        const stored = sessionStorage.getItem(HANDOFF_KEY);
        if (!stored) return;
        const current = JSON.parse(stored) as ConciergeHandoff;
        if (current.openedAt === handoff.openedAt) sessionStorage.removeItem(HANDOFF_KEY);
      } catch {
        // Expiration is also enforced when the handoff is read.
      }
    }, HANDOFF_MAX_AGE_MS + 100);
  } catch {
    // Contact navigation still works without attribution storage.
  }
  return handoff;
}

export function readContactHandoff() {
  try {
    const stored = sessionStorage.getItem(HANDOFF_KEY);
    if (!stored) return undefined;
    const handoff = JSON.parse(stored) as ConciergeHandoff;
    const age = Date.now() - new Date(handoff.openedAt).getTime();
    if (!handoff.sessionId || !Number.isFinite(age) || age < 0 || age > HANDOFF_MAX_AGE_MS) {
      sessionStorage.removeItem(HANDOFF_KEY);
      return undefined;
    }
    return handoff;
  } catch {
    return undefined;
  }
}

export function clearContactHandoff() {
  try {
    sessionStorage.removeItem(HANDOFF_KEY);
  } catch {
    // Nothing else depends on storage cleanup.
  }
}
