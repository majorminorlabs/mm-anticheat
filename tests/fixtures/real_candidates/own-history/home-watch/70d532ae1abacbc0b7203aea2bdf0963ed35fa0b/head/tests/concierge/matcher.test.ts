import { describe, expect, it } from "vitest";
import {
  MAX_CONCIERGE_QUERY_LENGTH,
  matchConciergeQuery,
  normalizeConciergeQuery,
  redactUnansweredQuery,
  sanitizeConciergeInput,
  scoreConciergeEntry,
} from "@/lib/concierge/matcher";
import { conciergeEntryById } from "@/lib/concierge/knowledge-base";
import type { ConciergeEntry } from "@/lib/concierge/types";

function entry(
  id: string,
  overrides: Partial<ConciergeEntry> = {},
): ConciergeEntry {
  return {
    id,
    category: "about",
    label: id,
    questions: [`question for ${id}`],
    keywords: [],
    answer: `${id} answer`,
    enabled: true,
    ...overrides,
  };
}

describe("concierge input normalization", () => {
  it("sanitizes controls, angle brackets, whitespace, and non-string values", () => {
    expect(sanitizeConciergeInput("  <ask>\u0000\n  a   question  ")).toBe(
      "ask a question",
    );
    expect(sanitizeConciergeInput({ value: "not a string" })).toBe("");
  });

  it("enforces the public maximum query length", () => {
    const sanitized = sanitizeConciergeInput("x".repeat(500));
    expect(sanitized).toHaveLength(MAX_CONCIERGE_QUERY_LENGTH);
    expect(normalizeConciergeQuery("x".repeat(500))).toHaveLength(
      MAX_CONCIERGE_QUERY_LENGTH,
    );
  });

  it("normalizes punctuation, casing, whitespace, and approved aliases", () => {
    expect(
      normalizeConciergeQuery(
        "  Can you INSPECT A/C, piers & hurricane flooding?  ",
      ),
    ).toBe("can you check hvac dock storm water leak");
  });

  it.each([
    ["air conditioner", "hvac"],
    ["air conditioning", "hvac"],
    ["tropical storm", "storm"],
    ["water damage", "water leak"],
    ["docks", "dock"],
    ["boat lifts", "boat lift"],
    ["seawalls", "seawall"],
    ["cost", "price"],
    ["look at", "check"],
    ["vacation home", "seasonal home"],
    ["second home", "seasonal home"],
    ["break-in", "forced entry"],
    ["burglary", "forced entry"],
    ["yard service", "landscaping"],
    ["lawn care", "landscaping"],
    ["handyman", "repairs"],
    ["maintenance", "repairs"],
  ])("normalizes the %s synonym", (input, normalized) => {
    expect(normalizeConciergeQuery(input)).toBe(normalized);
  });
});

describe("deterministic matching", () => {
  it("returns exact normalized question matches with the maximum score", () => {
    const match = matchConciergeQuery("WHAT is Home Watch?!");

    expect(match.entry?.id).toBe("about-home-watch");
    expect(match.score).toBe(100);
    expect(match.confidence).toBe("high");
    expect(match.urgent).toBe(false);
  });

  it("matches keyword overlap without requiring an exact question", () => {
    const match = matchConciergeQuery("Is Fairhope covered?");

    expect(match.entry?.id).toBe("service-area");
    expect(match.score).toBeGreaterThanOrEqual(12);
  });

  it("uses alias normalization to reach the appropriate policy entry", () => {
    expect(matchConciergeQuery("Do you inspect the A/C?").entry?.id).toBe(
      "home-scope",
    );
    expect(matchConciergeQuery("Can you look at my pier?").entry?.id).toBe(
      "optional-property-items",
    );
    expect(matchConciergeQuery("Does it check docks?").entry?.id).toBe(
      "optional-property-items",
    );
    expect(matchConciergeQuery("Can you check my seawall?").entry?.id).toBe(
      "optional-property-items",
    );
    expect(matchConciergeQuery("What does it cost?").entry?.id).toBe(
      "plans-pricing",
    );
  });

  it("breaks ambiguous score ties by stable entry ID and returns alternatives", () => {
    const entries = [
      entry("z-topic", { keywords: ["shared term"] }),
      entry("a-topic", { keywords: ["shared term"] }),
      entry("m-topic", { keywords: ["shared term"] }),
    ];

    const match = matchConciergeQuery("shared term", entries);

    expect(match.entry?.id).toBe("a-topic");
    expect(match.alternatives.map(({ id }) => id)).toEqual([
      "m-topic",
      "z-topic",
    ]);
  });

  it("applies exclusions before exact, phrase, or keyword scoring", () => {
    const excluded = entry("excluded", {
      questions: ["dock repair"],
      keywords: ["dock"],
      phrases: ["dock repair"],
      exclusions: ["repair"],
    });

    expect(scoreConciergeEntry("dock repair", excluded)).toBe(0);
    expect(
      scoreConciergeEntry(
        normalizeConciergeQuery("dock maintenance"),
        conciergeEntryById.get("optional-property-items")!,
      ),
    ).toBe(0);
    expect(matchConciergeQuery("Can you do dock maintenance?").entry?.id).not.toBe(
      "optional-property-items",
    );
  });

  it("never selects disabled entries, even for an exact question", () => {
    const match = matchConciergeQuery("this answer is disabled");

    expect(match.entry).toBeNull();
    expect(match.alternatives).not.toContainEqual(
      expect.objectContaining({ id: "future-disabled-example" }),
    );
  });

  it("returns a low-confidence fallback instead of fabricating an answer", () => {
    const match = matchConciergeQuery("quantum banana orchestra");

    expect(match.entry).toBeNull();
    expect(match.confidence).toBe("low");
    expect(match.urgent).toBe(false);
  });

  it("offers the closest ranked topics when no entry clears the threshold", () => {
    const closest = entry("roof-topic", { keywords: ["roof"] });
    const match = matchConciergeQuery("roof quantum banana orchestra", [closest]);

    expect(match.entry).toBeNull();
    expect(match.score).toBeGreaterThan(0);
    expect(match.score).toBeLessThan(12);
    expect(match.alternatives.map(({ id }) => id)).toEqual(["roof-topic"]);
  });
});

describe("required policy routing", () => {
  it.each([
    ["do you care for pets", "limitations-pets"],
    ["can you feed my dog", "limitations-pets"],
    ["can you check my dock", "optional-property-items"],
    ["does it check docks", "optional-property-items"],
    ["do you check seawalls", "optional-property-items"],
    ["do you check boat lifts vehicles pools irrigation or generators", "optional-property-items"],
    ["do you provide landscaping", "limitations-landscaping-handyman"],
    ["do you do lawn care", "limitations-landscaping-handyman"],
    ["can you do handyman repairs", "limitations-landscaping-handyman"],
    ["minor correction policy", "minor-corrections"],
    ["what happens if a major issue is found", "problem-major"],
    ["can i choose a fixed weekday", "scheduling-flexible"],
  ])("routes %j to %s", (query, expectedId) => {
    expect(matchConciergeQuery(query).entry?.id).toBe(expectedId);
  });

  it.each([
    "Mobile",
    "Mobile Bay",
    "Dauphin Island",
    "Dog River",
    "Fowl River",
    "Theodore",
    "Belle Fontaine",
    "Coden",
    "Bayou La Batre",
    "Fairhope",
    "Daphne",
    "Point Clear",
    "Spanish Fort",
    "Eastern Shore",
  ])("routes the published %s area", (area) => {
    expect(matchConciergeQuery(`Do you serve ${area}?`).entry?.id).toBe(
      "service-area",
    );
  });

  it.each([
    ["active water leak at a watched property", "urgent-after-hours"],
    ["major storm damage", "urgent-after-hours"],
    ["property access issue", "urgent-after-hours"],
    ["visible forced entry discovered by the service", "urgent-after-hours"],
    ["existing client needs help after hours", "urgent-after-hours"],
  ])("routes business-call intent %j before ordinary matching", (query, id) => {
    const match = matchConciergeQuery(query);

    expect(match.entry?.id).toBe(id);
    expect(match.entry?.escalation).toBe("call-now");
    expect(match).toMatchObject({ score: 100, confidence: "high", urgent: true });
  });

  it.each([
    "there is a fire",
    "my house is on fire",
    "smoke inside now",
    "I smell gas",
    "I can smell gas",
    "active burglary",
    "burglary in progress",
    "someone is breaking into my house right now",
    "medical emergency",
    "he is having a heart attack",
    "someone is in immediate danger",
  ])("routes emergency intent %j to 911-first guidance", (query) => {
    const match = matchConciergeQuery(query);

    expect(match.entry?.id).toBe("urgent-emergency-services");
    expect(match.entry?.escalation).toBe("emergency-services");
    expect(match).toMatchObject({ score: 100, confidence: "high", urgent: true });
  });

  it.each([
    ["can you watch a rental", "about-rentals"],
    ["which plan should i choose", "plans-fit"],
    ["optional property checks", "optional-property-items"],
    ["what is your service area", "service-area"],
    ["do you keep keys", "access-keys"],
    ["what if the power is out", "problem-power-outage"],
    ["what if you see mold", "problem-mold-pest"],
    ["can you coordinate a vendor", "problem-vendor-needed"],
    ["request a quote", "getting-started"],
    ["can i book a consultation", "getting-started"],
  ])("marks contact handoff intent %j for contact escalation", (query, id) => {
    const match = matchConciergeQuery(query);

    expect(match.entry?.id).toBe(id);
    expect(match.entry?.escalation).toBe("contact");
  });
});

describe("unanswered-query privacy", () => {
  it("drops sensitive access details entirely", () => {
    expect(redactUnansweredQuery("the lockbox code is 1234")).toEqual({
      normalizedQuery: undefined,
      redactionReason: "sensitive-access-details",
    });
  });

  it.each([
    "lock box code is 1234",
    "the code to the lockbox is 1234",
    "the alarm is 1234",
    "access-code 1234",
  ])("drops common sensitive-detail wording: %s", (query) => {
    expect(redactUnansweredQuery(query)).toEqual({
      normalizedQuery: undefined,
      redactionReason: "sensitive-access-details",
    });
  });

  it("redacts a street address from an unanswered query", () => {
    const redacted = redactUnansweredQuery("Do you visit 123 Bay View Drive on Fridays?");
    expect(redacted.normalizedQuery).toContain("redacted address");
    expect(redacted.normalizedQuery).not.toContain("123 bay view drive");
  });

  it("redacts email addresses and long numbers", () => {
    const redacted = redactUnansweredQuery(
      "Email jane@example.com or call 251-555-0199",
    );

    expect(redacted.normalizedQuery).not.toMatch(/jane|example|251|555|0199/);
  });
});
