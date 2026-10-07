import { describe, expect, it } from "vitest";
import { summarizeConciergeSession } from "@/lib/concierge/summary";

describe("deterministic session summaries", () => {
  it("builds the approved topic/question/action sentence from known values", () => {
    expect(
      summarizeConciergeSession({
        categories: ["pricing", "storm-watch"],
        questionLabels: ["post-storm checks", "dock coverage"],
        openedContact: true,
        clickedPhone: false,
        submittedContact: false,
      }),
    ).toBe(
      "Visitor viewed Pricing and Storm Watch, asked about post-storm checks and dock coverage, then opened the contact form.",
    );
  });

  it("deduplicates values deterministically and limits each list to three", () => {
    expect(
      summarizeConciergeSession({
        categories: ["plans", "plans", "reports", "service-area", "about"],
        questionLabels: ["Plans", "Plans", "Reports", "Coverage", "Ignored"],
        openedContact: false,
        clickedPhone: false,
        submittedContact: false,
      }),
    ).toBe(
      "Visitor viewed Plans, Reports, and Service Area, asked about Plans, Reports, and Coverage, then closed the concierge.",
    );
  });

  it.each([
    [false, false, false, "then closed the concierge"],
    [true, false, false, "then opened the contact form"],
    [false, true, false, "then called the office"],
    [true, true, false, "then opened the contact form and called the office"],
    [true, true, true, "then submitted the contact form"],
  ])(
    "uses deterministic action precedence for contact=%s phone=%s submit=%s",
    (openedContact, clickedPhone, submittedContact, action) => {
      expect(
        summarizeConciergeSession({
          categories: ["about"],
          questionLabels: [],
          openedContact,
          clickedPhone,
          submittedContact,
        }),
      ).toBe(`Visitor viewed Home Watch basics, ${action}.`);
    },
  );

  it("uses a deterministic general-help label for an empty session", () => {
    expect(
      summarizeConciergeSession({
        categories: [],
        questionLabels: [],
        openedContact: false,
        clickedPhone: false,
        submittedContact: false,
      }),
    ).toBe("Visitor viewed general help, then closed the concierge.");
  });
});
