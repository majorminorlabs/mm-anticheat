export const conciergeCategories = [
  "about",
  "plans",
  "pricing",
  "exterior-watch",
  "home-watch",
  "home-watch-plus",
  "visit-process",
  "reports",
  "storm-watch",
  "leak-sensors",
  "contractor-coordination",
  "arrival-prep",
  "optional-checks",
  "service-area",
  "scheduling",
  "access-and-keys",
  "problems-found",
  "limitations",
  "getting-started",
  "urgent-situations",
] as const;

export const CONCIERGE_KNOWLEDGE_VERSION = "2026-07-12.1";

export type ConciergeCategory = (typeof conciergeCategories)[number];

export type ConciergeLink = {
  id: string;
  label: string;
  href: string;
};

export type ConciergeEntry = {
  id: string;
  category: ConciergeCategory;
  label: string;
  questions: string[];
  keywords: string[];
  phrases?: string[];
  exclusions?: string[];
  answer: string;
  links?: ConciergeLink[];
  followUpIds?: string[];
  escalation?: "contact" | "call-now" | "emergency-services";
  enabled: boolean;
};

export type ConfidenceTier = "high" | "medium" | "low";

export type ConciergeMatch = {
  entry: ConciergeEntry | null;
  score: number;
  confidence: ConfidenceTier;
  normalizedQuery: string;
  alternatives: ConciergeEntry[];
  urgent: boolean;
};

export const conciergeEventTypes = [
  "session_started",
  "concierge_opened",
  "suggestion_selected",
  "query_matched",
  "answer_shown",
  "query_unanswered",
  "answer_link_clicked",
  "phone_clicked",
  "contact_clicked",
  "contact_form_submitted",
  "session_ended",
] as const;

export type ConciergeEventType = (typeof conciergeEventTypes)[number];

export type ConciergeEvent = {
  eventId: string;
  sessionId: string;
  occurredAt: string;
  type: ConciergeEventType;
  pagePath: string;
  questionId?: string;
  entryId?: string;
  category?: ConciergeCategory;
  confidence?: ConfidenceTier;
  matchScore?: number;
  linkId?: string;
  normalizedQuery?: string;
  redactionReason?: string;
  summary?: string;
  knowledgeVersion: string;
  metadata?: {
    openedOnPath?: string;
    landingPath?: string;
    referrerHost?: string;
    utmSource?: string;
    utmMedium?: string;
    utmCampaign?: string;
    utmContent?: string;
    utmTerm?: string;
  };
};

export type ConciergeHandoff = {
  sessionId: string;
  entryId?: string;
  sourcePath: string;
  openedAt: string;
  landingPath?: string;
  referrerHost?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
};
