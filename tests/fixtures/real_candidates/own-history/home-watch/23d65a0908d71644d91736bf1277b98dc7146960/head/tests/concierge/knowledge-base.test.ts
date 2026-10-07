import { describe, expect, it } from "vitest";
import {
  conciergeEntries,
  conciergeEntryById,
  getConciergeEntry,
  initialConciergeEntryIds,
} from "@/lib/concierge/knowledge-base";

function requiredEntry(id: string) {
  const entry = conciergeEntryById.get(id);
  expect(entry, `Missing knowledge-base entry: ${id}`).toBeDefined();
  return entry!;
}

describe("knowledge-base integrity", () => {
  it("uses unique stable IDs", () => {
    const ids = conciergeEntries.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps initial choices and enabled follow-ups resolvable", () => {
    for (const id of initialConciergeEntryIds) {
      expect(getConciergeEntry(id)).toBeDefined();
    }
    for (const entry of conciergeEntries.filter(({ enabled }) => enabled)) {
      for (const id of entry.followUpIds ?? []) {
        expect(getConciergeEntry(id), `${entry.id} -> ${id}`).toBeDefined();
      }
    }
  });

  it("does not expose disabled entries through the public lookup", () => {
    expect(getConciergeEntry("future-disabled-example")).toBeUndefined();
  });
});

describe("approved operating-policy content", () => {
  it("uses the approved minor-correction language verbatim", () => {
    expect(requiredEntry("minor-corrections").answer).toBe(
      "Minor corrective actions are handled case by case. The technician will contact the office before making any change, and owner approval may be required.",
    );
  });

  it("requires immediate owner contact, reporting, and approval for major issues", () => {
    const entry = requiredEntry("problem-major");
    expect(entry.escalation).toBe("call-now");
    expect(entry.answer).toMatch(/calls the owner immediately/i);
    expect(entry.answer).toMatch(/issue, notes, and available photos/i);
    expect(entry.answer).toMatch(/only with owner approval/i);
  });

  it("states flexible scheduling without promising a fixed day or time", () => {
    const answer = requiredEntry("scheduling-flexible").answer;
    expect(answer).toMatch(/flexible scheduling/i);
    expect(answer).toMatch(/fixed weekday or exact arrival time is not promised/i);
    expect(answer).toMatch(/unless the office separately agrees/i);
  });

  it("prohibits pet handling and care", () => {
    const answer = requiredEntry("limitations-pets").answer;
    expect(answer).toMatch(/pet handling and pet care are not offered/i);
    expect(answer).toMatch(/do not require the technician to handle or care/i);
  });

  it("makes optional property items owner-approved, conditional, and visual-only", () => {
    const entry = requiredEntry("optional-property-items");
    for (const item of [
      "Vehicles",
      "boats",
      "docks",
      "piers",
      "boat lifts",
      "pools",
      "irrigation",
      "generators",
      "waterfront structures",
    ]) {
      expect(entry.answer.toLowerCase()).toContain(item.toLowerCase());
    }
    expect(entry.answer).toMatch(/owner-approved checklist items/i);
    expect(entry.answer).toMatch(/not automatic(?:ally included)? in every plan/i);
    expect(entry.answer).toMatch(/visual check only/i);
    expect(entry.answer).toMatch(
      /not operation, testing, maintenance, diagnosis, repair, marine surveying, or landscaping/i,
    );
  });

  it("clearly rejects landscaping and handyman work", () => {
    const answer = requiredEntry("limitations-landscaping-handyman").answer;
    expect(answer).toMatch(/landscaping, lawn care, handyman work, maintenance, and repairs are not offered/i);
    expect(answer).toMatch(/does not include operation, testing, diagnosis, or repair/i);
  });

  it("contains every published service area and nearby-route guidance", () => {
    const answer = requiredEntry("service-area").answer;
    for (const area of [
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
    ]) {
      expect(answer.toLowerCase()).toContain(area.toLowerCase());
    }
    expect(answer).toContain(
      "Routes are based on practical travel distance rather than strict city limits. Submit the property location through the contact form and the office will confirm availability.",
    );
  });

  it("keeps after-hours help separate from emergency response", () => {
    const afterHours = requiredEntry("urgent-after-hours");
    expect(afterHours.escalation).toBe("call-now");
    expect(afterHours.answer).toMatch(/existing client property concerns/i);
    expect(afterHours.answer).toMatch(/not emergency response/i);
    expect(afterHours.answer).toMatch(/not.*substitute for 911/i);

    const emergency = requiredEntry("urgent-emergency-services");
    expect(emergency.escalation).toBe("emergency-services");
    expect(emergency.answer).toContain(
      "If anyone may be in immediate danger, call 911 first. After emergency services have been contacted, you may also call Mobile Bay Home Watch.",
    );
  });
});
