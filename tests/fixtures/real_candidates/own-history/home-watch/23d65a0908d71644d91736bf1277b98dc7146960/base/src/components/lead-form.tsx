"use client";

import { FormEvent, useState } from "react";
import { concernOptions, pilot } from "@/content/site";

type LeadFormProps = {
  compact?: boolean;
  interest?: "storm" | "leak" | "coastal" | "home-watch";
};

const propertyTypes = [
  "Vacation home",
  "Waterfront home",
  "Single-family home",
  "Rental property",
  "Inherited property",
  "Seasonal home",
  "Condo",
  "Vacant lot",
];

const defaultConcernByInterest: Record<
  NonNullable<LeadFormProps["interest"]>,
  string
> = {
  storm: "Storm checks",
  leak: "Leaks and water damage",
  coastal: "General property watch",
  "home-watch": "General property watch",
};

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

export function LeadForm({ compact = false, interest }: LeadFormProps) {
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">(
    "idle",
  );
  const [message, setMessage] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("loading");
    setMessage("");

    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());

    try {
      const response = await fetch("/api/lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const payload = (await response.json()) as { message?: string };

      if (!response.ok) {
        throw new Error(payload.message || "Please check the form and try again.");
      }

      form.reset();
      setStatus("success");
      setMessage(payload.message || pilot.successMessage);
      window.gtag?.("event", "interest_list_signup", {
        property_area: data.propertyArea || "(not given)",
        concern: data.concern || "(not given)",
      });
    } catch (error) {
      setStatus("error");
      setMessage(
        error instanceof Error
          ? error.message
          : "Something went wrong. Please email us directly.",
      );
    }
  }

  return (
    <form className="lead-form" onSubmit={handleSubmit}>
      <div className="form-grid">
        <label>
          <span>Name</span>
          <input name="name" type="text" autoComplete="name" required />
        </label>
        <label>
          <span>Email</span>
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          <span>Phone (optional)</span>
          <input name="phone" type="tel" autoComplete="tel" />
        </label>
        <label>
          <span>Property area</span>
          <input
            name="propertyArea"
            type="text"
            placeholder="Fairhope, Dauphin Island, Fowl River..."
            required
          />
        </label>
        <label>
          <span>Property ZIP code (optional)</span>
          <input
            name="propertyZip"
            type="text"
            inputMode="numeric"
            autoComplete="postal-code"
            maxLength={10}
          />
        </label>
        <label>
          <span>Property type</span>
          <select name="propertyType" defaultValue="" required>
            <option value="" disabled>
              Select property type
            </option>
            {propertyTypes.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Biggest concern</span>
          <select
            name="concern"
            defaultValue={interest ? defaultConcernByInterest[interest] : ""}
            required
          >
            <option value="" disabled>
              Select one
            </option>
            {concernOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        {!compact ? (
          <>
            <label>
              <span>Waterfront?</span>
              <select name="waterfront" defaultValue="">
                <option value="" disabled>
                  Select one
                </option>
                <option>Yes</option>
                <option>No</option>
                <option>Not sure</option>
              </select>
            </label>
            <label>
              <span>How often is it vacant?</span>
              <select name="vacancy" defaultValue="">
                <option value="" disabled>
                  Select one
                </option>
                <option>Seasonally</option>
                <option>Several weeks at a time</option>
                <option>Most of the year</option>
                <option>Varies</option>
              </select>
            </label>
          </>
        ) : null}

        <label className="form-grid__wide">
          <span>Notes (optional)</span>
          <textarea
            name="notes"
            rows={compact ? 3 : 4}
            aria-label="Notes about the property"
          />
        </label>
      </div>

      <button
        className="button button--primary"
        type="submit"
        disabled={status === "loading"}
      >
        <span>{status === "loading" ? "Sending..." : "Send property details"}</span>
      </button>

      <p className="form-disclosure">{pilot.formDisclosure}</p>

      <p className={`form-status form-status--${status}`} aria-live="polite">
        {message}
      </p>
    </form>
  );
}
