import { InclusionList, IntroBlock, PageHero, PhotoFrame } from "@/components/sections";
import { LeadForm } from "@/components/lead-form";
import { images, trustSignals } from "@/content/site";
import { createPageMetadata } from "@/lib/metadata";

export const metadata = createPageMetadata({
  path: "/about",
  title: "About Our Home Watch Service",
  description:
    "Local owner-operator positioning, trust signals, and service standards for Mobile Bay Home Watch around Mobile Bay.",
});

export default function AboutPage() {
  return (
    <>
      <PageHero
        image={images.marsh}
        schemaPath="/about"
        schemaType="AboutPage"
        eyebrow="ABOUT"
        title="Local, careful, practical property oversight."
        description="Mobile Bay Home Watch is built for absentee homeowners who need consistent eyes on the property, documented reporting, and local coordination when something needs attention."
        breadcrumbs={[{ label: "Home", href: "/" }, { label: "About" }]}
      />
      <IntroBlock
        eyebrow="HOW WE WORK"
        title="A local route, run the same way every time."
        align="left"
      >
        <p>
          Mobile Bay Home Watch is run locally around Mobile Bay. Every property
          on the route gets the same checklist, the same photo report format,
          and the same owner communication standard, whether it&apos;s a
          weekend condo or a waterfront estate.
        </p>
        <p>
          We keep the service area small enough to visit reliably and know
          each property well, rather than spreading thin across a wide
          territory.
        </p>
      </IntroBlock>
      <section className="section about-grid">
        <div className="container about-grid__inner" data-reveal>
          <PhotoFrame image={images.dock} />
          <div>
            <h2>What owners can expect</h2>
            <InclusionList items={trustSignals} />
          </div>
        </div>
      </section>
      <section className="section lead-section">
        <div className="container lead-section__grid" data-reveal>
          <div>
            <h2>Discuss property access and reporting expectations.</h2>
            <p>
              Our written service agreement covers route frequency, key
              handling, owner notifications, leak sensor expectations, and
              emergency boundaries before your first visit.
            </p>
          </div>
          <LeadForm compact />
        </div>
      </section>
    </>
  );
}
