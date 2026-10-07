import Link from "next/link";
import { IntroBlock, PageHero } from "@/components/sections";
import { images, site } from "@/content/site";
import { createPageMetadata } from "@/lib/metadata";

export const metadata = createPageMetadata({
  path: "/privacy",
  title: "Privacy Policy",
  description:
    "How Mobile Bay Home Watch handles website inquiries, property details, analytics data, and IP-derived location information.",
});

export default function PrivacyPage() {
  return (
    <>
      <PageHero
        image={images.marsh}
        schemaPath="/privacy"
        eyebrow="PRIVACY POLICY"
        title="How website information is handled."
        description="This policy explains what the Mobile Bay Home Watch website collects, why it is used, and where it may be sent when you contact us or submit property details."
        breadcrumbs={[{ label: "Home", href: "/" }, { label: "Privacy Policy" }]}
      />
      <IntroBlock
        eyebrow="PLAIN-LANGUAGE PRIVACY"
        title="Information is collected when you choose to contact us and when the site operates."
      >
        <p>
          This policy applies to information handled through this website. The
          site is currently designed to collect early-interest, quote, and
          service inquiries and to measure how visitors use the site.
        </p>
        <p>Last updated July 12, 2026.</p>
      </IntroBlock>

      <section className="section disclaimers">
        <div className="container text-column" data-reveal>
          <section>
            <h2>Information you submit</h2>
            <p>
              The contact and quote forms ask for your name, email address,
              property area, property type, and biggest concern. They may also
              collect a phone number, property ZIP code, whether a property is
              waterfront, how often it is vacant, and any notes you choose to
              provide.
            </p>
            <p>
              Those fields can include information about a property and how it
              is used. Please do not submit alarm codes, lock combinations,
              financial information, government identification numbers, or
              other sensitive access or identity information through the form.
              If you contact us directly by phone or email, we receive the
              information you choose to provide in that communication.
            </p>
          </section>

          <section>
            <h2>Home Watch Concierge</h2>
            <p>
              Home Watch Concierge answers questions using approved website
              content and deterministic matching; it does not use a generative
              AI service. An anonymous browser-session identifier, event
              timestamps, page paths, selected topic IDs, matched answer IDs,
              confidence tier, clicked links, phone and contact actions, and a
              rule-based session summary may be recorded to understand whether
              the tool is useful. The answer itself can be reconstructed from
              its stable answer ID and published knowledge version.
            </p>
            <p>
              A typed question is matched in the browser. Matched question text
              is not sent to Google Analytics or the private event endpoint. If
              there is no confident answer, a normalized version may be sent
              for content review after email addresses, phone-like numbers,
              URLs, and similar details are removed. Questions that appear to
              contain access codes, lockbox details, passwords, or payment data
              are omitted instead. Please do not enter names, addresses,
              access codes, alarm details, payment data, or other sensitive
              information in the concierge.
            </p>
            <p>
              When the contact form is opened from the concierge, short-lived
              session storage makes the selected answer ID, source page, and
              allowed campaign fields eligible for attribution for up to 30
              minutes. Expired data is removed by an active expiry timer or
              when the form next checks it, and browser session storage also
              clears when its session ends. This allows a successful form
              submission to be attributed to the concierge. The form receives
              no typed concierge question.
            </p>
          </section>

          <section>
            <h2>Location and technical information</h2>
            <p>
              When a form is submitted, the website reads location headers
              supplied by its hosting platform. When available, the submission
              record includes an approximate city, state or region, postal
              code, and country derived from the network request. The form
              handler does not add the raw IP address to the lead record, but
              the hosting platform and other providers may process IP addresses
              as part of delivering, securing, or measuring the website.
            </p>
            <p>
              Web servers and analytics providers may also receive ordinary
              technical data such as browser and device information, referring
              pages, requested pages, timestamps, and interactions with the
              site.
            </p>
          </section>

          <section>
            <h2>Analytics</h2>
            <p>
              The site can load Google Analytics when a Google Analytics
              measurement ID is configured. Google Analytics measures site use
              and receives events for successful interest-list submissions,
              email-link clicks, selected call-to-action clicks, and concierge
              interactions. A successful form event includes the selected
              concern, lead source, and source page; it does not intentionally
              send the property area, name, email address, phone number, notes,
              anonymous concierge session ID, typed question, or full form
              submission to Google Analytics.
            </p>
            <p>
              The site can also load Microsoft Clarity when a Clarity project
              ID is configured. Clarity helps show how visitors interact with
              the site, such as page activity and interaction patterns. These
              analytics tools are not loaded by this site unless their
              corresponding deployment setting is configured. When enabled,
              they may use cookies or similar browser technologies under their
              own terms and privacy practices.
            </p>
          </section>

          <section>
            <h2>How the information is used</h2>
            <p>Website information may be used to:</p>
            <ul>
              <li>receive and respond to early-interest and quote inquiries;</li>
              <li>
                understand the requested property area, service interest, and
                whether an inquiry fits the planned service route;
              </li>
              <li>operate, troubleshoot, and protect the website and forms;</li>
              <li>
                measure site use and improve content, navigation, and inquiry
                paths; and
              </li>
              <li>
                keep a record of communications and follow-up related to an
                inquiry.
              </li>
            </ul>
          </section>

          <section>
            <h2>Where information is sent</h2>
            <p>
              The website is hosted on Vercel. A form submission that passes
              validation sends limited non-contact operational status to the
              application log and is sent through Resend to the Mobile Bay
              Home Watch email inbox. If a
              lead-capture webhook is configured for the deployment, the same
              submission record is also forwarded to that configured endpoint.
              That record includes the form fields, submission time, and any
              available IP-derived city, state or region, postal code, and
              country.
            </p>
            <p>
              Concierge events are accepted by a same-origin endpoint. When a
              private concierge event destination is configured, validated,
              privacy-reduced events are forwarded to it over HTTPS. If no
              destination is configured, the endpoint does not persist them.
              Event delivery is best effort and a logging failure does not
              prevent an answer from appearing.
            </p>
            <p>
              When configured, Google Analytics and Microsoft Clarity receive
              the analytics information described above. These hosting, email,
              lead-capture, and analytics providers process information for
              their respective technical functions and under their own terms
              and privacy practices.
            </p>
          </section>

          <section>
            <h2>Retention</h2>
            <p>
              Event-level concierge records and redacted unanswered questions
              are designated for deletion after 90 days; the configured private
              event destination must enforce that limit. Anonymous aggregate
              totals may be retained longer. Contact-form records may remain in
              the receiving email account, analytics systems, or a configured
              lead-capture system until deleted under the settings and
              processes used for those systems. You may contact us to ask about
              or request correction or deletion of information you submitted.
            </p>
          </section>

          <section>
            <h2>Your choices</h2>
            <p>
              You can choose not to submit the website form and instead contact
              us using only the information needed for your question. Browser
              privacy settings, content blockers, and provider opt-out tools
              may limit analytics cookies or scripts. Blocking those tools may
              affect measurement of site use.
            </p>
            <p>
              To ask what information you submitted, request a correction or
              deletion, or raise a privacy question, email{" "}
              <Link className="inline-link" href={site.emailHref}>
                {site.email}
              </Link>
              . A request may require enough information to identify the
              relevant submission.
            </p>
          </section>

          <section>
            <h2>Security and changes to this policy</h2>
            <p>
              The public website uses HTTPS, and the form handler sends email
              data to Resend over HTTPS. No website, transmission method, or
              storage system can be guaranteed completely secure. Avoid sending
              sensitive property-access details through the public form.
            </p>
            <p>
              This policy may be updated if the website, forms, providers, or
              data practices change. The date above will identify the published
              version.
            </p>
          </section>
        </div>
      </section>
    </>
  );
}
