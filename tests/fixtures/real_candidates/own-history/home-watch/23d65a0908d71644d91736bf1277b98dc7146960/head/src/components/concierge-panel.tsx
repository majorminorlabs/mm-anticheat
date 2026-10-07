"use client";

import type { FormEvent, KeyboardEvent, RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, MessageCircleQuestion, Phone, Send, X } from "lucide-react";
import {
  getConciergeEntry,
  initialConciergeEntryIds,
} from "@/lib/concierge/knowledge-base";
import {
  matchConciergeQuery,
  MAX_CONCIERGE_QUERY_LENGTH,
  redactUnansweredQuery,
  sanitizeConciergeInput,
} from "@/lib/concierge/matcher";
import { summarizeConciergeSession } from "@/lib/concierge/summary";
import type {
  ConciergeCategory,
  ConciergeEntry,
  ConciergeMatch,
} from "@/lib/concierge/types";
import {
  createContactHandoff,
  getConciergeSession,
  recordConciergeEvent,
} from "@/lib/concierge/client-events";
import { site } from "@/content/site";

type ConciergePanelProps = {
  open: boolean;
  launcherRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
};

const fallbackAnswer =
  "I don’t have an exact answer for that yet. You can choose a related topic below or send the property details to our office.";

function contactHref(entryId?: string) {
  const params = new URLSearchParams(window.location.search);
  const destination = new URLSearchParams();
  for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]) {
    const value = params.get(key);
    if (value) destination.set(key, value.slice(0, 100));
  }
  destination.set("via", "concierge");
  if (entryId) destination.set("intent", entryId);
  return `/contact?${destination.toString()}#contact-form`;
}

function answerParagraphs(answer: string) {
  return answer.split("\n\n").map((paragraph) => <p key={paragraph}>{paragraph}</p>);
}

export function ConciergePanel({ open, launcherRef, onClose }: ConciergePanelProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const answerRef = useRef<HTMLDivElement>(null);
  const closingRef = useRef(false);
  const sessionStartedRef = useRef(false);
  const sessionEndedRef = useRef(false);
  const categoriesRef = useRef<ConciergeCategory[]>([]);
  const questionsRef = useRef<string[]>([]);
  const openedContactRef = useRef(false);
  const clickedPhoneRef = useRef(false);
  const submittedContactRef = useRef(false);
  const [query, setQuery] = useState("");
  const [currentEntry, setCurrentEntry] = useState<ConciergeEntry | null>(null);
  const [match, setMatch] = useState<ConciergeMatch | null>(null);
  const [hasAnswered, setHasAnswered] = useState(false);

  const initialEntries = useMemo(
    () => initialConciergeEntryIds.map(getConciergeEntry).filter(Boolean) as ConciergeEntry[],
    [],
  );

  const followUps = useMemo(() => {
    if (!currentEntry?.followUpIds) return [];
    return currentEntry.followUpIds
      .map(getConciergeEntry)
      .filter(Boolean)
      .slice(0, 4) as ConciergeEntry[];
  }, [currentEntry]);

  const sendSessionEnd = useCallback((beacon = false) => {
    if (!sessionStartedRef.current || sessionEndedRef.current) return;
    sessionEndedRef.current = true;
    const summary = summarizeConciergeSession({
      categories: categoriesRef.current,
      questionLabels: questionsRef.current,
      openedContact: openedContactRef.current,
      clickedPhone: clickedPhoneRef.current,
      submittedContact: submittedContactRef.current,
    });
    recordConciergeEvent(
      {
        type: "session_ended",
        pagePath: window.location.pathname,
        summary,
      },
      { beacon },
    );
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      closingRef.current = false;
      dialog.showModal();
      requestAnimationFrame(() => closeRef.current?.focus());

      const session = getConciergeSession();
      if (!sessionStartedRef.current) {
        sessionStartedRef.current = true;
        recordConciergeEvent({
          type: "session_started",
          pagePath: window.location.pathname,
          metadata: {
            openedOnPath: window.location.pathname,
            landingPath: session.landingPath,
            referrerHost: session.referrerHost,
            utmSource: session.utmSource,
            utmMedium: session.utmMedium,
            utmCampaign: session.utmCampaign,
            utmContent: session.utmContent,
            utmTerm: session.utmTerm,
          },
        });
      }
      recordConciergeEvent({
        type: "concierge_opened",
        pagePath: window.location.pathname,
      });
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const handlePageHide = () => {
      if (!sessionStartedRef.current) return;
      sendSessionEnd(true);
    };
    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, [sendSessionEnd]);

  useEffect(() => {
    const handleContactSubmitted = () => {
      submittedContactRef.current = true;
    };
    window.addEventListener("concierge:contact-submitted", handleContactSubmitted);
    return () => window.removeEventListener("concierge:contact-submitted", handleContactSubmitted);
  }, []);

  function requestClose() {
    if (closingRef.current) return;
    closingRef.current = true;
    dialogRef.current?.close();
    onClose();
    requestAnimationFrame(() => launcherRef.current?.focus());
  }

  function rememberEntry(entry: ConciergeEntry) {
    if (!categoriesRef.current.includes(entry.category)) {
      categoriesRef.current.push(entry.category);
    }
    if (!questionsRef.current.includes(entry.label)) {
      questionsRef.current.push(entry.label);
    }
  }

  function selectEntry(entry: ConciergeEntry, suggested = true) {
    setCurrentEntry(entry);
    setMatch(null);
    setHasAnswered(true);
    rememberEntry(entry);
    if (suggested) {
      recordConciergeEvent({
        type: "suggestion_selected",
        pagePath: window.location.pathname,
        questionId: entry.id,
        entryId: entry.id,
        category: entry.category,
      });
    }
    recordConciergeEvent({
      type: "answer_shown",
      pagePath: window.location.pathname,
      entryId: entry.id,
      category: entry.category,
    });
    requestAnimationFrame(() => answerRef.current?.focus({ preventScroll: true }));
  }

  function submitQuery(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const safeQuery = sanitizeConciergeInput(query);
    if (!safeQuery) {
      inputRef.current?.focus();
      return;
    }

    const result = matchConciergeQuery(safeQuery);
    setMatch(result);
    setCurrentEntry(result.entry);
    setHasAnswered(true);

    if (result.entry) {
      rememberEntry(result.entry);
      recordConciergeEvent({
        type: "query_matched",
        pagePath: window.location.pathname,
        entryId: result.entry.id,
        category: result.entry.category,
        confidence: result.confidence,
        matchScore: result.score,
      });
      recordConciergeEvent({
        type: "answer_shown",
        pagePath: window.location.pathname,
        entryId: result.entry.id,
        category: result.entry.category,
      });
    } else {
      const redacted = redactUnansweredQuery(safeQuery);
      recordConciergeEvent({
        type: "query_unanswered",
        pagePath: window.location.pathname,
        confidence: "low",
        matchScore: result.score,
        normalizedQuery: redacted.normalizedQuery,
        redactionReason: redacted.redactionReason,
      });
    }
  }

  function trackAnswerLink(entry: ConciergeEntry, linkId: string) {
    recordConciergeEvent({
      type: "answer_link_clicked",
      pagePath: window.location.pathname,
      entryId: entry.id,
      category: entry.category,
      linkId,
    });
    requestClose();
  }

  function openContact(entryId?: string) {
    createContactHandoff(entryId);
    openedContactRef.current = true;
    recordConciergeEvent({
      type: "contact_clicked",
      pagePath: window.location.pathname,
      entryId,
    });

    const form = document.getElementById("contact-form");
    if (form) {
      requestClose();
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      form.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
      const firstField = form.querySelector<HTMLElement>("input, select, textarea");
      window.setTimeout(() => firstField?.focus({ preventScroll: true }), reduceMotion ? 0 : 350);
      return;
    }

    requestClose();
    window.location.assign(contactHref(entryId));
  }

  function callOffice() {
    clickedPhoneRef.current = true;
    recordConciergeEvent({
      type: "phone_clicked",
      pagePath: window.location.pathname,
      entryId: currentEntry?.id,
      category: currentEntry?.category,
    });
  }

  function trapFocus(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      requestClose();
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => element.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const answer = currentEntry?.answer || (hasAnswered ? fallbackAnswer : "");
  const relatedEntries = currentEntry
    ? followUps
    : match?.alternatives.length
      ? match.alternatives
      : initialEntries;
  const isEmergency = currentEntry?.escalation === "emergency-services";
  const showCallProminently =
    currentEntry?.escalation === "call-now" || currentEntry?.escalation === "emergency-services";

  return (
    <dialog
      ref={dialogRef}
      id="home-watch-concierge"
      className="concierge-dialog"
      aria-labelledby="concierge-title"
      aria-describedby="concierge-description"
      data-clarity-mask="True"
      onKeyDown={trapFocus}
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div className="concierge-panel">
        <header className="concierge-header">
          <div className="concierge-heading">
            <MessageCircleQuestion aria-hidden="true" size={22} strokeWidth={1.7} />
            <div>
              <p className="concierge-kicker">QUICK PROPERTY ANSWERS</p>
              <h2 id="concierge-title">Home Watch Concierge</h2>
            </div>
          </div>
          <button
            ref={closeRef}
            className="concierge-close"
            type="button"
            onClick={requestClose}
            aria-label="Close Home Watch Concierge"
          >
            <X aria-hidden="true" size={22} strokeWidth={1.8} />
          </button>
        </header>

        <div className="concierge-body">
          <p id="concierge-description" className="concierge-intro">
            Get quick answers about services, pricing, property checks, storm support,
            reports, and our service area.
          </p>

          {!hasAnswered ? (
            <section aria-labelledby="concierge-topics-heading">
              <h3 id="concierge-topics-heading" className="concierge-section-title">
                Choose a topic
              </h3>
              <div className="concierge-choices">
                {initialEntries.map((entry) => (
                  <button
                    key={entry.id}
                    className="concierge-choice"
                    type="button"
                    onClick={() => selectEntry(entry)}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {hasAnswered ? (
            <section className="concierge-result" aria-labelledby="concierge-answer-heading">
              <div
                ref={answerRef}
                className={`concierge-answer${isEmergency ? " concierge-answer--emergency" : ""}`}
                role={isEmergency ? "alert" : "status"}
                aria-live={isEmergency ? "assertive" : "polite"}
                aria-atomic="true"
                tabIndex={-1}
              >
                <h3 id="concierge-answer-heading">
                  {currentEntry?.label || "We need a little more detail"}
                </h3>
                {answerParagraphs(answer)}
              </div>

              {isEmergency ? (
                <a className="concierge-action concierge-action--emergency" href="tel:911">
                  Call 911 first
                </a>
              ) : null}

              {currentEntry?.links?.length ? (
                <div className="concierge-answer-links" aria-label="Related pages">
                  {currentEntry.links.map((link) =>
                    link.id === "contact" ? (
                      <button
                        key={link.id}
                        className="concierge-text-link"
                        type="button"
                        onClick={() => openContact(currentEntry.id)}
                      >
                        {link.label}
                        <ExternalLink aria-hidden="true" size={15} />
                      </button>
                    ) : (
                      <a
                        key={link.id}
                        className="concierge-text-link"
                        href={link.href}
                        onClick={() => trackAnswerLink(currentEntry, link.id)}
                      >
                        {link.label}
                        <ExternalLink aria-hidden="true" size={15} />
                      </a>
                    ),
                  )}
                </div>
              ) : null}

              {relatedEntries.length ? (
                <section aria-labelledby="concierge-related-heading">
                  <h3 id="concierge-related-heading" className="concierge-section-title">
                    {currentEntry ? "Related questions" : "Closest topics"}
                  </h3>
                  <div className="concierge-choices concierge-choices--followup">
                    {relatedEntries.slice(0, 4).map((entry) => (
                      <button
                        key={entry.id}
                        className="concierge-choice"
                        type="button"
                        onClick={() => selectEntry(entry)}
                      >
                        {entry.label}
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}
            </section>
          ) : null}

          <form className="concierge-question" onSubmit={submitQuery}>
            <label htmlFor="concierge-query">Ask a short question</label>
            <div className="concierge-question__controls">
              <input
                ref={inputRef}
                id="concierge-query"
                name="question"
                type="text"
                value={query}
                maxLength={MAX_CONCIERGE_QUERY_LENGTH}
                autoComplete="off"
                enterKeyHint="send"
                aria-describedby="concierge-query-warning"
                placeholder="Example: Do you check boat lifts?"
                onChange={(event) => setQuery(event.target.value)}
              />
              <button type="submit" aria-label="Ask question">
                <Send aria-hidden="true" size={19} strokeWidth={1.8} />
              </button>
            </div>
            <p id="concierge-query-warning">
              Don’t enter access codes, alarm details, or other sensitive information.
            </p>
          </form>
        </div>

        <footer className="concierge-footer">
          <a
            className={`concierge-action${showCallProminently ? " concierge-action--prominent" : ""}`}
            href={site.phoneHref}
            onClick={callOffice}
          >
            <Phone aria-hidden="true" size={18} strokeWidth={1.8} />
            Call {site.phone}
          </a>
          <button
            className="concierge-action concierge-action--primary"
            type="button"
            onClick={() => openContact(currentEntry?.id)}
          >
            Send property details
          </button>
        </footer>
      </div>
    </dialog>
  );
}
