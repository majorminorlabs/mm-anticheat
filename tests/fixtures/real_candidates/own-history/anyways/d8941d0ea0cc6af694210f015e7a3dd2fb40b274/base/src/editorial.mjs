/** Canonical editorial doctrine. Keep classification and prompt work pointed
 * here rather than duplicating active taxonomy lists across the application. */
export const SECTIONS = [
  { slug: 'digital-collectibles', name: 'Digital Collectibles', question: 'What becomes collectible when ownership moves on-chain?' },
  { slug: 'defi', name: 'DeFi', question: 'How are financial systems being rebuilt in public?' },
  { slug: 'markets', name: 'Markets', question: 'Where are capital, risk, and attention moving next?' },
  { slug: 'chains', name: 'Chains', question: 'Which networks are becoming the places where activity compounds?' },
  { slug: 'products', name: 'Products', question: 'What does Web3 make newly useful for ordinary people?' },
  { slug: 'culture', name: 'Culture', question: 'What do internet-native communities make, want, and fight about?' }
];

// Retired values remain readable for existing records and immutable migration
// history. They are never offered to editors or emitted by active prompts.
export const LEGACY_SECTION_ALIASES = Object.freeze({
  internet: 'culture',
  systems: 'products',
  taste: 'culture',
  media: 'culture',
  'modern-life': 'products',
  builders: 'products'
});

export const SECTION_ORDER = SECTIONS.map(section => section.slug);
export const SECTION_PROMISES = Object.fromEntries(SECTIONS.map(section => [section.slug, section.question]));

// Story form is deliberately separate from the primary section. A Chains story
// can be a quick Meanwhile or a full feature; the section says where it belongs
// and the form tells the newsroom how much reporting and time it needs.
export const STORY_FORMS = Object.freeze([
  { id: 'meanwhile', name: 'Meanwhile...', target: 350, minimum: 250, maximum: 500, purpose: 'A quick observation, trend, or curiosity.', minimumSources: 3, evidence: 'At least three quality sources, one memorable observation, and one strong visual opportunity.' },
  { id: 'while-youre-here', name: 'While You’re Here', target: 700, minimum: 500, maximum: 900, purpose: 'An interesting side story or culture piece.', minimumSources: 5, evidence: 'At least five sources, two or three concrete examples, and one surprising detail.' },
  { id: 'worth-your-time', name: 'Worth Your Time', target: 900, minimum: 700, maximum: 1100, purpose: 'A deep recommendation or profile.', minimumSources: 6, evidence: 'Six to ten sources, multiple people, organizations, or case studies, and at least one primary source.' },
  { id: 'receipts', name: 'Receipts', target: 1400, minimum: 1100, maximum: 1800, purpose: 'A document-driven investigation.', minimumSources: 10, evidence: 'Ten or more sources, multiple primary documents, every major claim sourced, and an original insight.' },
  { id: 'anyways', name: 'Anyways', target: 1500, minimum: 1200, maximum: 2000, purpose: 'A signature feature story.', minimumSources: 10, evidence: 'Ten or more sources, multiple primary documents where available, every major claim sourced, and an original insight.' },
  { id: 'we-read-it', name: 'We Read It So You Don’t Have To', target: 900, minimum: 700, maximum: 1200, purpose: 'A dense report or filing distilled for readers.', minimumSources: 6, evidence: 'Six to ten sources, the report or filing itself where possible, multiple concrete findings, and every major claim sourced.' }
]);
export const STORY_FORM_ORDER = STORY_FORMS.map(form => form.id);
export const ARTICLE_LENGTHS = Object.freeze([
  { id: 'brief', name: 'Brief', minimum: 250, maximum: 500 },
  { id: 'standard', name: 'Standard', minimum: 500, maximum: 1100 },
  { id: 'feature', name: 'Feature', minimum: 1100, maximum: 2000 }
]);
export const ARTICLE_LENGTH_ORDER = ARTICLE_LENGTHS.map(length => length.id);
export const LEGACY_STORY_FORM_ALIASES = Object.freeze({ builders: 'worth-your-time', systems: 'anyways' });
const LEGACY_STORY_FORMS = [
  { id: 'builders', name: 'Legacy profile', target: 1300, minimum: 1000, maximum: 1700, purpose: 'Legacy profile contract.', minimumSources: 6, evidence: 'Six to ten sources and at least one primary source.' },
  { id: 'systems', name: 'Legacy explainer', target: 1500, minimum: 1200, maximum: 2000, purpose: 'Legacy systems explainer contract.', minimumSources: 10, evidence: 'Ten or more sources and multiple primary documents.' }
];
export const STORY_FORM_BY_ID = Object.freeze(Object.fromEntries([...STORY_FORMS, ...LEGACY_STORY_FORMS].map(form => [form.id, form])));
export const STORY_FORM_DOCTRINE = `Choose exactly one optional section independently from the primary lens. Sections and contracts: ${STORY_FORMS.map(form => `${form.name}: ${form.minimum}-${form.maximum} words (target ${form.target}); ${form.purpose} Evidence gate: ${form.evidence}`).join(' | ')}. Every story must justify its length: 300 words earns one surprising idea; 700 words earns that idea plus enough evidence; 1,200 words earns one argument with reporting; 1,800+ words earns multiple threads, competing viewpoints, and broader implications. Do not pad, repeat arguments, or invent reporting to reach a count. If the available evidence cannot support the next tier, choose the shorter eligible section or stop for research.`;

export const BEAT_ORDER = ['ethereum', 'bitcoin', 'solana', 'base', 'hyperliquid', 'robinhood-chain', 'nfts', 'digital-art', 'gaming-assets', 'wallets', 'stablecoins', 'rwas', 'memecoins', 'founders', 'communities', 'brands', 'infrastructure', 'prediction-markets', 'security'];
export const BEAT_ALIASES = Object.freeze({
  brand: 'brands',
  'artificial-intelligence': 'ai',
  'film-and-tv': 'film-tv',
  'film-television': 'film-tv'
});

export const SIGNIFICANCE_TEST = [
  'changes what people can do', 'changes what people want', 'changes who has power',
  'reveals a hidden system', 'explains how attention moves', 'shows how online culture affects reality',
  'reveals a new way to build something', 'explains why a person, company, movement, or object matters',
  'reflects a broader cultural change', 'helps readers understand the modern world differently'
];

export const EDITORIAL_CLASSIFICATION_HELP = 'Choose one primary section. Add secondary sections when a story genuinely belongs in more than one place. Add recurring topics and searchable tags only when they help readers find the story. A publishable pitch should meet at least two significance tests.';

// This is a writing contract, not a list of decorative adjectives. The story
// form tells readers how long the read is; the section tells the writer what
// the reporting has to reveal about contemporary life.
export const ANYWAYS_VOICE = `Anyways is not a wire service. Begin with the pressure, contradiction, or lived consequence that makes the update worth a reader's time, then establish the news. The primary lens is the story's governing question, not a metadata tag: answer it through reporting and make its answer the article's argument. Build the piece in movements: the concrete change, the mechanism behind it, the human or cultural stake, and the limit or tradeoff that keeps the claim honest. Let short declarative lines interrupt denser reporting when the thought needs room. End on a sharpened consequence, not a recap or a generic call to watch what happens next. Never open with the form name, “Meanwhile,” a company announcement, or a neutral summary of the source. Do not use canned contrasts, rhetorical questions with supplied answers, em dashes, slogan-like triads, inflated trend language, or a paragraph that merely restates the lede. Use specific nouns, verbs, people, dates, and constraints from the source packet. The voice should feel observant, clear-eyed, a little surprising, and earned by the evidence.`;

// Compact doctrine for any future research, topic-generation, drafting, or
// classification prompt. Keep runtime prompts pointed here instead of copying
// a longer editorial manual into each call.
export const EDITORIAL_PROMPT_DOCTRINE = `Anyways covers the blockchain ecosystem and the products, companies, people, communities, and cultural movements that grow out of Web3. Classify each story with exactly one primary section, zero or more secondary sections, recurring beats, and narrow searchable tags where useful. Primary sections: ${SECTIONS.map(section => `${section.name} (${section.question})`).join('; ')}. Recurring beats: ${BEAT_ORDER.join(', ')}. Keep NFT and NFTs searchable as tags, never as a primary section. Security remains a topic. Memecoins generally belong under Culture. A strong angle satisfies at least two tests: ${SIGNIFICANCE_TEST.join('; ')}. Reject commodity announcements, press releases, trend-list filler, and generic token price updates without a meaningful market, product, institutional, or cultural angle. ${STORY_FORM_DOCTRINE} Return primarySection, secondarySections, beats, tags, significanceRationale, and coreQuestion.`;

export function canonicalSectionId(value) {
  const id = String(value || '').trim().toLowerCase().replace(/\s+/g, '-');
  return SECTION_ORDER.includes(id) ? id : LEGACY_SECTION_ALIASES[id] || id;
}

export function canonicalStoryFormId(value) {
  const id = String(value || '').trim().toLowerCase().replace(/\s+/g, '-');
  return STORY_FORM_ORDER.includes(id) ? id : LEGACY_STORY_FORM_ALIASES[id] || id;
}

export function canonicalBeatId(value) {
  const id = String(value || '').trim().toLowerCase().replace(/&/g, 'and').replace(/[\s_\/]+/g, '-');
  return BEAT_ORDER.includes(id) ? id : BEAT_ALIASES[id] || id;
}
