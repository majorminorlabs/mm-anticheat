import { esc } from './article-renderer.mjs';

const PAGE_COPY = Object.freeze({
  about: {
    title: 'About',
    description: 'What Anyways is, what it covers, and how the publication works.',
    heading: 'A publication for the signal underneath the noise.',
    body: '<p>Anyways follows the stories where internet culture, money, software, and real life start rubbing against each other.</p><p>We publish reported work, explainers, criticism, and useful short reads. Every published item has a source record and a human editorial decision behind it.</p>'
  },
  standards: {
    title: 'Editorial standards',
    description: 'How Anyways reports, verifies, labels, and corrects its work.',
    heading: 'Make the claim earn its place.',
    body: '<p>Material claims must be traceable to reliable evidence. We prefer primary records, identify uncertainty, distinguish allegation from fact, and preserve the source trail used by the desk.</p><p>Automation can help find, organize, or draft material. It does not replace human verification or publication approval.</p>'
  },
  corrections: {
    title: 'Corrections',
    description: 'How Anyways handles errors, updates, and reader reports.',
    heading: 'If we get it wrong, we say so plainly.',
    body: '<p>Material corrections are dated and described on the affected story. We distinguish a correction from a later editorial update and retain the previous public revision internally.</p><p>Report a possible error through the <a href="/contact">contact route</a>. Include the story URL and the specific passage or source at issue.</p>'
  },
  'ai-policy': {
    title: 'AI and automation policy',
    description: 'Anyways policy for AI-assisted research, drafting, and editorial automation.',
    heading: 'Tools can propose. People remain accountable.',
    body: '<p>Anyways may use software and language models for bounded discovery, research organization, draft assistance, and quality checks. Generated material is treated as a proposal, never as an authoritative source.</p><p>A human editor must review evidence, claims, wording, disclosures, and the final publication decision. We do not publish invented quotes, unsupported facts, or model output as reporting.</p>'
  },
  privacy: {
    title: 'Privacy',
    description: 'Anyways privacy notice for readers, analytics, and contact information.',
    heading: 'Read quietly.',
    body: '<p>Anyways uses limited first-party signals to understand whether the publication is useful. We do not need a reader account to read the site, and we do not sell reader information.</p><p>Do Not Track and Global Privacy Control are respected. Analytics requests are bounded, retained for a defined period, and can be disabled in the browser. <button type="button" class="more-link" id="analytics-opt-out">Disable optional analytics</button></p><p>Contact messages are used only to handle the request.</p>'
  },
  terms: {
    title: 'Terms',
    description: 'Terms for using the Anyways public site.',
    heading: 'Use the work thoughtfully.',
    body: '<p>The site and its editorial work are provided for personal, informational use. Do not interfere with the service, scrape private newsroom routes, or misrepresent copied work as your own.</p><p>Stories may link to external sources. Those sites have their own terms, availability, and privacy practices.</p>'
  },
  accessibility: {
    title: 'Accessibility',
    description: 'Anyways accessibility commitment and feedback route.',
    heading: 'The edition should work for more people.',
    body: '<p>We aim for WCAG 2.2 AA across keyboard, touch, zoom, reduced-motion, contrast, and screen-reader use. Reading content is available in the document without requiring client-side JavaScript.</p><p>If something blocks access, tell us through the <a href="/contact">contact route</a> with the page, device, browser, and a description of the barrier.</p>'
  },
  contact: {
    title: 'Contact',
    description: 'Contact Anyways with a correction, story tip, accessibility issue, or general question.',
    heading: 'Find the desk.',
    body: '<p>For a correction, include the story URL and the evidence that changes the claim. For a tip, include what happened, where the primary record lives, and why it matters now.</p><p>Use the publication’s configured contact channel for sensitive material. Do not send passwords, private keys, or personal data that the desk does not need.</p>'
  },
  ownership: {
    title: 'Ownership and disclosures',
    description: 'How Anyways describes ownership, funding, conflicts, and commercial relationships.',
    heading: 'The context behind the publication matters.',
    body: '<p>Anyways publishes its ownership and funding disclosures here as the publication formalizes them. Commercial relationships, affiliate links, and sponsored work must be labeled clearly and kept separate from independent editorial decisions.</p><p>If a conflict could affect a story, the desk records it and discloses the relevant context to readers.</p>'
  }
});

export function trustPage(slug) {
  return PAGE_COPY[String(slug || '').replace(/^\//, '')] || null;
}

export function trustPageSlugs() {
  return Object.keys(PAGE_COPY);
}

export function renderTrustPage(slug) {
  const page = trustPage(slug);
  if (!page) return '';
  return `<article class="trust-page"><header class="zone-head"><p class="zone-kicker mono">[ Anyways / ${esc(page.title)} ]</p><h1 class="zone-name">${esc(page.heading)}</h1><p class="zone-promise">${esc(page.description)}</p></header><div class="trust-copy prose">${page.body}</div><nav class="trust-nav" aria-label="Publication information"><a href="/about">About</a><a href="/standards">Standards</a><a href="/corrections">Corrections</a><a href="/ai-policy">AI policy</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/accessibility">Accessibility</a><a href="/contact">Contact</a><a href="/ownership">Ownership</a></nav></article>`;
}
