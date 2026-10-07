import { NextResponse } from "next/server";

type LeadPayload = Record<string, unknown>;

function isNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0;
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function readLocationHeader(request: Request, name: string) {
  const value = request.headers.get(name);
  if (!value) return null;

  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export async function POST(request: Request) {
  let payload: LeadPayload;

  try {
    payload = (await request.json()) as LeadPayload;
  } catch {
    return NextResponse.json(
      { message: "Unable to read the form submission." },
      { status: 400 },
    );
  }

  const requiredFields = ["name", "email", "propertyArea", "concern"];
  const missing = requiredFields.filter((field) => !isNonEmptyString(payload[field]));

  if (missing.length > 0) {
    return NextResponse.json(
      { message: "Please complete name, email, property area, and biggest concern." },
      { status: 400 },
    );
  }

  const email = String(payload.email).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json(
      { message: "Please enter a valid email address." },
      { status: 400 },
    );
  }

  const lead = {
    receivedAt: new Date().toISOString(),
    name: payload.name,
    email,
    phone: payload.phone || null,
    propertyArea: payload.propertyArea,
    propertyZip: payload.propertyZip || null,
    propertyType: payload.propertyType || null,
    concern: payload.concern,
    waterfront: payload.waterfront || null,
    vacancy: payload.vacancy || null,
    notes: payload.notes || null,
    visitorLocation: {
      city: readLocationHeader(request, "x-vercel-ip-city"),
      state: readLocationHeader(request, "x-vercel-ip-country-region"),
      zip: readLocationHeader(request, "x-vercel-ip-postal-code"),
      country: readLocationHeader(request, "x-vercel-ip-country"),
    },
  };

  console.info("Interest list signup", lead);

  const resendApiKey = process.env.RESEND_API_KEY;
  if (!resendApiKey) {
    console.error("RESEND_API_KEY is not configured");
    return NextResponse.json(
      { message: "We couldn't save your signup. Please email us directly." },
      { status: 500 },
    );
  }

  const details = [
    ["Name", lead.name],
    ["Email", lead.email],
    ["Phone", lead.phone],
    ["Property area", lead.propertyArea],
    ["Property ZIP code", lead.propertyZip],
    ["Property type", lead.propertyType],
    ["Biggest concern", lead.concern],
    ["Waterfront", lead.waterfront],
    ["Vacancy", lead.vacancy],
    ["Notes", lead.notes],
    ["Visitor city", lead.visitorLocation.city],
    ["Visitor state", lead.visitorLocation.state],
    ["Visitor ZIP code", lead.visitorLocation.zip],
    ["Visitor country", lead.visitorLocation.country],
  ];

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Mobile Bay Home Watch <leads@mobilebayhomewatch.com>",
        to: ["hello@mobilebayhomewatch.com"],
        reply_to: email,
        subject: `New early interest: ${String(lead.name)}`,
        html: `
          <h1>New early interest submission</h1>
          <table style="border-collapse:collapse">
            ${details
              .map(
                ([label, value]) => `
                  <tr>
                    <th style="padding:6px 16px 6px 0;text-align:left;vertical-align:top">${escapeHtml(label)}</th>
                    <td style="padding:6px 0">${escapeHtml(value || "Not provided")}</td>
                  </tr>`,
              )
              .join("")}
          </table>
        `,
      }),
    });

    if (!response.ok) {
      console.error("Resend email failed", response.status, await response.text());
      return NextResponse.json(
        { message: "We couldn't save your signup. Please email us directly." },
        { status: 502 },
      );
    }
  } catch (error) {
    console.error("Resend email failed", error);
    return NextResponse.json(
      { message: "We couldn't save your signup. Please email us directly." },
      { status: 502 },
    );
  }

  // Forward to a capture endpoint (Zapier / Make / Google Apps Script webhook)
  // when LEAD_WEBHOOK_URL is configured. Signups are only logged otherwise.
  const webhookUrl = process.env.LEAD_WEBHOOK_URL;
  if (webhookUrl) {
    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(lead),
      });
      if (!response.ok) {
        console.error("Lead webhook responded", response.status);
      }
    } catch (error) {
      console.error("Lead webhook failed", error);
      return NextResponse.json(
        { message: "We couldn't save your signup. Please email us directly." },
        { status: 502 },
      );
    }
  }

  return NextResponse.json({
    message:
      "You're on the list. We'll follow up when pilot openings are available in your area.",
  });
}
