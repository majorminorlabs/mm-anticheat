import {
  addOnSummaryRows,
  plans,
  publicAddOns,
} from "@/content/site";
import { ButtonLink, Eyebrow, InclusionList } from "@/components/sections";

export function PricingTable() {
  const standardPlans = plans.filter((plan) => plan.slug !== "custom-package");
  const customPlan = plans.find((plan) => plan.slug === "custom-package");

  return (
    <>
      <div className="pricing-plan-grid" data-reveal>
        {standardPlans.map((plan) => {
          const featured = plan.name === "Home Watch";
          return (
            <section
              key={plan.slug}
              className={`pricing-plan-card ${featured ? "is-featured" : ""}`}
            >
              <div className="pricing-plan-card__top">
                <h2 className="eyebrow pricing-eyebrow-heading">{plan.name}</h2>
                <p className="pricing-plan-card__price">{plan.price}</p>
                <p className="pricing-plan-card__visits">{plan.frequency}</p>
              </div>
              <div className="pricing-plan-card__includes">
                <p className="pricing-plan-card__label">Included:</p>
                <InclusionList items={plan.includes} />
              </div>
              <p className="pricing-plan-card__best-for">
                <strong>Best for:</strong> {plan.bestFor}
              </p>
              <div className="pricing-plan-card__actions">
                <ButtonLink href={`#plan-${plan.slug}`} variant="text">
                  More info
                </ButtonLink>
              </div>
            </section>
          );
        })}
      </div>

      {customPlan ? (
        <section className="pricing-custom-quote" data-reveal>
          <div>
            <Eyebrow>Custom Packages Available</Eyebrow>
            <h2>Need more than the standard plans?</h2>
            <p>
              {customPlan.summary}. Contact us for a custom quote if the
              property needs a broader scope or more hands-on coordination.
            </p>
          </div>
          <div className="pricing-custom-quote__actions">
            <p>
              Best for: {customPlan.bestFor}
            </p>
            <ButtonLink href="/contact">Contact us for a custom quote</ButtonLink>
          </div>
        </section>
      ) : null}

      <div className="pricing-groups pricing-groups--plans">
        {plans.map((plan) => (
          <section
            key={plan.slug}
            id={`plan-${plan.slug}`}
            className="pricing-plan-detail"
            data-reveal
          >
            <h2 className="eyebrow pricing-eyebrow-heading">{plan.name}</h2>
            <p className="pricing-section__price">
              {plan.price} <span className="pricing-section__frequency">{plan.frequency}</span>
            </p>
            <p>{plan.intro}</p>
            {plan.carryover ? <p className="pricing-section__carryover">{plan.carryover}</p> : null}
            {plan.details?.length ? (
              <ul className="pricing-detail-list">
                {plan.details.map((row) => (
                  <li key={`${plan.slug}-${row.area}`}>
                    <strong>{row.area}:</strong> {row.details}
                  </li>
                ))}
              </ul>
            ) : null}
            {plan.optionalAddOn ? (
              <div className="pricing-detail-note">
                <h3>Optional add-on</h3>
                <p>{plan.optionalAddOn}</p>
              </div>
            ) : null}
          </section>
        ))}
      </div>

      <div className="pricing-table-wrap pricing-table-wrap--summary" data-reveal>
        <table className="pricing-table pricing-table--summary">
          <caption>Add-ons at a glance</caption>
          <thead>
            <tr>
              <th scope="col">Add-On</th>
              <th scope="col">Price</th>
              <th scope="col">Includes</th>
            </tr>
          </thead>
          <tbody>
            {addOnSummaryRows.map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                <td>{row.price}</td>
                <td>{row.includes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="pricing-groups">
        {publicAddOns.map((addOn) => (
          <section key={addOn.name} data-reveal>
            <h2 className="eyebrow pricing-eyebrow-heading">{addOn.name}</h2>
            <p className="pricing-section__price">{addOn.price}</p>
            <p>{addOn.summary}</p>
            <div className="pricing-table-wrap pricing-table-wrap--detail">
              <table className="pricing-table pricing-table--detail">
                <caption>{addOn.name} included items</caption>
                <thead>
                  <tr>
                    <th scope="col">Item</th>
                    <th scope="col">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {addOn.rows.map((row) => (
                    <tr key={`${addOn.name}-${row.item}`}>
                      <th scope="row">{row.item}</th>
                      <td>{row.details}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {addOn.notIncluded?.length ? (
              <div className="pricing-detail-note">
                <h3>Not offered</h3>
                <InclusionList items={addOn.notIncluded} variant="exclude" />
              </div>
            ) : null}
            {addOn.accessNote ? (
              <p className="pricing-detail-note service-disclaimer">
                {addOn.accessNote}
              </p>
            ) : null}
            {addOn.goodFor?.length ? (
              <div className="pricing-detail-note">
                <h3>Good for</h3>
                <InclusionList items={addOn.goodFor} />
              </div>
            ) : null}
            {addOn.optionalByRequest?.length ? (
              <div className="pricing-detail-note">
                <h3>Optional by request</h3>
                <InclusionList items={addOn.optionalByRequest} />
              </div>
            ) : null}
          </section>
        ))}
      </div>
    </>
  );
}
