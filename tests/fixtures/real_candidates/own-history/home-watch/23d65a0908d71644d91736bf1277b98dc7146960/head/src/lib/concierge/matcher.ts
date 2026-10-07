import { conciergeEntries } from "@/lib/concierge/knowledge-base";
import type { ConciergeEntry, ConciergeMatch } from "@/lib/concierge/types";

export const MAX_CONCIERGE_QUERY_LENGTH = 240;
export const MIN_CONCIERGE_MATCH_SCORE = 12;

const aliases: Array<[RegExp, string]> = [
  [/\ba\s*\/\s*c\b/gi, "hvac"],
  [/\bair[- ]?condition(?:er|ing)?\b/gi, "hvac"],
  [/\bac unit\b/gi, "hvac"],
  [/\btropical (?:storm|system)\b/gi, "storm"],
  [/\bhurricane\b/gi, "storm"],
  [/\bwater damage\b/gi, "water leak"],
  [/\bflood(?:ing|ed)?\b/gi, "water leak"],
  [/\bpiers?\b/gi, "dock"],
  [/\bboat lifts?\b/gi, "boat lift"],
  [/\bpricing\b|\bcosts?\b|\brates?\b/gi, "price"],
  [/\binspect(?:ion|ing|ed)?\b|\blook(?:ing)? at\b|\bwatch(?:ing)?\b/gi, "check"],
  [/\bvacation home\b|\bsecond home\b/gi, "seasonal home"],
  [/\bbreak[- ]?in\b/gi, "forced entry"],
  [/\bburglary\b/gi, "forced entry"],
  [/\byard service\b|\blawn care\b/gi, "landscaping"],
  [/\bhandyman\b|\bmaintenance\b/gi, "repairs"],
];

const ignoredTokens = new Set([
  "a",
  "an",
  "and",
  "are",
  "at",
  "be",
  "can",
  "do",
  "does",
  "for",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "the",
  "to",
  "we",
  "what",
  "when",
  "where",
  "will",
  "with",
  "you",
  "your",
]);

const emergencyPatterns = [
  /\b(?:active|house|property|home) fire\b/,
  /\b(?:my|our|the)? ?(?:house|home|property|building) (?:is )?on fire\b/,
  /\bthere (?:is|s) (?:a )?fire\b/,
  /\bfire (?:right )?now\b/,
  /\bsmoke\b.*\b(?:danger|active|now|inside)\b/,
  /\b(?:suspected|active) gas leak\b/,
  /\b(?:i|we) (?:can )?smell gas\b/,
  /\bsmell of gas\b/,
  /\bactive (?:burglary|forced entry|break in)\b/,
  /\b(?:burglary|forced entry|break in) (?:is )?in progress\b/,
  /\b(?:someone|somebody|a person|an intruder) (?:is )?(?:breaking|forcing) (?:in|into)\b/,
  /\bmedical emergency\b/,
  /\b(?:heart attack|not breathing|unconscious|severe bleeding)\b/,
  /\bimmediate (?:danger|threat)\b/,
  /\b(?:person|someone|anyone) (?:is|may be) in danger\b/,
  /\bcall 911\b/,
];

const businessCallPatterns = [
  /\bactive water leak\b/,
  /\bmajor (?:visible )?storm damage\b/,
  /\bproperty access (?:issue|problem)\b/,
  /\bvisible forced entry\b/,
  /\bexisting client\b.*\bafter hours\b/,
  /\bafter hours\b.*\b(?:help|assistance|urgent)\b/,
];

export function sanitizeConciergeInput(value: unknown) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CONCIERGE_QUERY_LENGTH);
}

export function normalizeConciergeQuery(value: unknown) {
  let normalized = sanitizeConciergeInput(value)
    .normalize("NFKD")
    .replace(/[’']/g, "")
    .toLowerCase();

  for (const [pattern, replacement] of aliases) {
    normalized = normalized.replace(pattern, replacement);
  }

  return normalized
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasTerm(query: string, term: string) {
  const normalizedTerm = normalizeConciergeQuery(term);
  if (!normalizedTerm) return false;
  return (` ${query} `).includes(` ${normalizedTerm} `);
}

function meaningfulTokens(value: string) {
  return new Set(
    normalizeConciergeQuery(value)
      .split(" ")
      .filter((token) => token.length > 1 && !ignoredTokens.has(token)),
  );
}

export function scoreConciergeEntry(query: string, entry: ConciergeEntry) {
  if (!entry.enabled || !query) return 0;
  if (entry.exclusions?.some((term) => hasTerm(query, term))) return 0;

  const normalizedQuestions = entry.questions.map(normalizeConciergeQuery);
  if (normalizedQuestions.includes(query)) return 100;

  let score = 0;
  for (const question of normalizedQuestions) {
    if (question.length > 5 && (query.includes(question) || question.includes(query))) {
      score = Math.max(score, 32);
    }
  }

  for (const phrase of entry.phrases || []) {
    if (hasTerm(query, phrase)) score += 18;
  }

  let matchedKeywords = 0;
  for (const keyword of entry.keywords) {
    if (hasTerm(query, keyword)) matchedKeywords += 1;
  }
  score += Math.min(matchedKeywords * 6, 30);

  const queryTokens = meaningfulTokens(query);
  const entryTokens = meaningfulTokens(
    `${entry.label} ${entry.questions.join(" ")} ${entry.keywords.join(" ")}`,
  );
  let overlap = 0;
  for (const token of queryTokens) {
    if (entryTokens.has(token)) overlap += 1;
  }
  if (queryTokens.size > 0) score += Math.round((overlap / queryTokens.size) * 10);

  return score;
}

function confidenceForScore(score: number): ConciergeMatch["confidence"] {
  if (score >= 32) return "high";
  if (score >= MIN_CONCIERGE_MATCH_SCORE) return "medium";
  return "low";
}

export function matchConciergeQuery(
  rawQuery: unknown,
  entries: ConciergeEntry[] = conciergeEntries,
): ConciergeMatch {
  const normalizedQuery = normalizeConciergeQuery(rawQuery);
  const enabledEntries = entries.filter((entry) => entry.enabled);

  const emergencyEntry = enabledEntries.find(
    (entry) => entry.id === "urgent-emergency-services",
  );
  if (emergencyEntry && emergencyPatterns.some((pattern) => pattern.test(normalizedQuery))) {
    return {
      entry: emergencyEntry,
      score: 100,
      confidence: "high",
      normalizedQuery,
      alternatives: [],
      urgent: true,
    };
  }

  const callEntry = enabledEntries.find((entry) => entry.id === "urgent-after-hours");
  if (callEntry && businessCallPatterns.some((pattern) => pattern.test(normalizedQuery))) {
    return {
      entry: callEntry,
      score: 100,
      confidence: "high",
      normalizedQuery,
      alternatives: [],
      urgent: true,
    };
  }

  const ranked = enabledEntries
    .map((entry) => ({ entry, score: scoreConciergeEntry(normalizedQuery, entry) }))
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));

  const best = ranked[0];
  const isConfident = Boolean(best && best.score >= MIN_CONCIERGE_MATCH_SCORE);

  return {
    entry: isConfident ? best.entry : null,
    score: best?.score || 0,
    confidence: confidenceForScore(best?.score || 0),
    normalizedQuery,
    alternatives: ranked
      .filter((result) => !isConfident || result.entry.id !== best?.entry.id)
      .slice(0, 3)
      .map((result) => result.entry),
    urgent: false,
  };
}

const sensitiveQueryPattern =
  /\b(?:alarm|gate|key|lock\s*box|lockbox|access|door|pin|password|combination|credit card|bank account|social security)\b/i;

export function redactUnansweredQuery(value: string) {
  if (sensitiveQueryPattern.test(value)) {
    return { normalizedQuery: undefined, redactionReason: "sensitive-access-details" };
  }

  const redacted = normalizeConciergeQuery(
    sanitizeConciergeInput(value)
      .replace(/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/gi, " redacted email ")
      .replace(/\b(?:https?:\/\/|www\.)\S+/gi, " redacted url ")
      .replace(
        /\b\d{1,6}\s+[a-z0-9.' -]{2,40}\s+(?:street|st|road|rd|avenue|ave|drive|dr|lane|ln|boulevard|blvd|court|ct|way|circle|cir|highway|hwy)\b/gi,
        " redacted address ",
      )
      .replace(/\b(?:\d[\d ()+.-]?){7,}\b/g, " redacted number "),
  ).slice(0, 180);

  return { normalizedQuery: redacted || undefined, redactionReason: undefined };
}
