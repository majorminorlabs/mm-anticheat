import type { ConciergeCategory } from "@/lib/concierge/types";

const categoryLabels: Record<ConciergeCategory, string> = {
  about: "Home Watch basics",
  plans: "Plans",
  pricing: "Pricing",
  "exterior-watch": "Exterior Watch",
  "home-watch": "Home Watch",
  "home-watch-plus": "Home Watch Plus",
  "visit-process": "Visit Process",
  reports: "Reports",
  "storm-watch": "Storm Watch",
  "leak-sensors": "Leak Sensors",
  "contractor-coordination": "Contractor Coordination",
  "arrival-prep": "Arrival Prep",
  "optional-checks": "Optional Checks",
  "service-area": "Service Area",
  scheduling: "Scheduling",
  "access-and-keys": "Access and Keys",
  "problems-found": "Problems Found",
  limitations: "Service Limitations",
  "getting-started": "Getting Started",
  "urgent-situations": "Urgent Situations",
};

type SummaryInput = {
  categories: ConciergeCategory[];
  questionLabels: string[];
  openedContact: boolean;
  clickedPhone: boolean;
  submittedContact: boolean;
};

function joinLabels(values: string[]) {
  const unique = [...new Set(values)].slice(0, 3);
  if (unique.length <= 1) return unique[0] || "general help";
  if (unique.length === 2) return `${unique[0]} and ${unique[1]}`;
  return `${unique[0]}, ${unique[1]}, and ${unique[2]}`;
}

export function summarizeConciergeSession(input: SummaryInput) {
  const topics = joinLabels(input.categories.map((category) => categoryLabels[category]));
  const questions = joinLabels(input.questionLabels);
  let action = "then closed the concierge";
  if (input.submittedContact) action = "then submitted the contact form";
  else if (input.openedContact && input.clickedPhone) action = "then opened the contact form and called the office";
  else if (input.openedContact) action = "then opened the contact form";
  else if (input.clickedPhone) action = "then called the office";

  if (input.questionLabels.length > 0) {
    return `Visitor viewed ${topics}, asked about ${questions}, ${action}.`;
  }
  return `Visitor viewed ${topics}, ${action}.`;
}
