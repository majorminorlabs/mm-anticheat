export const HERMES_EDITORIAL_CONTRACT_VERSION = 'hermes-editorial-v1';
export const HERMES_STANDARD_WORD_TARGET = Object.freeze({ minimum: 600, maximum: 900 });

const PRIMARY_SECTIONS = new Set(['digital-collectibles', 'defi', 'markets', 'chains', 'products', 'culture', 'memecoins']);
const STORY_FORMS = new Set(['meanwhile', 'while-youre-here', 'worth-your-time', 'receipts', 'anyways', 'we-read-it']);
const CLAIM_STATUSES = new Set(['supported', 'needs_review', 'disputed', 'inferred']);

const text = value => typeof value === 'string' ? value.trim() : '';

export function wordCount(value = '') {
  return text(value).split(/\s+/).filter(Boolean).length;
}

export function markdownSourceLinks(value = '') {
  return [...text(value).matchAll(/\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/g)].map(match => match[1]);
}

export function rawUrlsOutsideMarkdownLinks(value = '') {
  const withoutLinks = text(value).replace(/\[[^\]]+\]\(https?:\/\/[^)\s]+\)/g, '');
  return [...withoutLinks.matchAll(/https?:\/\/[^\s)]+/gi)].map(match => match[0]);
}

function validHttpUrl(value) {
  try {
    const url = new URL(text(value));
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function addRequired(errors, packageValue, key, label = key) {
  if (!text(packageValue?.[key])) errors.push(label + ' is required.');
}

export function validateHermesStoryPackage(packageValue = {}) {
  const errors = [];
  const warnings = [];
  const value = packageValue && typeof packageValue === 'object' && !Array.isArray(packageValue) ? packageValue : {};

  addRequired(errors, value, 'headline', 'Headline');
  addRequired(errors, value, 'dek', 'Dek');
  addRequired(errors, value, 'body_markdown', 'Article body');
  addRequired(errors, value, 'social_post', 'Social post');
  addRequired(errors, value, 'research_markdown', 'Research packet');

  if (text(value.headline).length > 160) errors.push('Headline must be 160 characters or fewer.');
  if (text(value.dek).length > 600) errors.push('Dek must be 600 characters or fewer.');
  if (text(value.social_post).length > 4000) errors.push('Social post must be 4000 characters or fewer.');
  if (text(value.body_markdown).length < 200 || text(value.body_markdown).length > 200000) errors.push('Article body must be between 200 and 200,000 characters.');
  if (text(value.research_markdown).length < 80 || text(value.research_markdown).length > 200000) errors.push('Research packet must be between 80 and 200,000 characters.');

  const bodyLinks = markdownSourceLinks(value.body_markdown);
  if (!bodyLinks.length) errors.push('Article body needs at least one inline Markdown source link.');
  if (rawUrlsOutsideMarkdownLinks(value.body_markdown).length) errors.push('Article body must use inline Markdown links instead of raw URLs.');

  const bodyWords = wordCount(value.body_markdown);
  if (bodyWords < HERMES_STANDARD_WORD_TARGET.minimum || bodyWords > HERMES_STANDARD_WORD_TARGET.maximum) {
    warnings.push('Standard articles target ' + HERMES_STANDARD_WORD_TARGET.minimum + '-' + HERMES_STANDARD_WORD_TARGET.maximum + ' words; this draft has ' + bodyWords + '.');
  }
  if (!/^##\s+\S/m.test(text(value.body_markdown))) {
    warnings.push('No section heading was supplied. The editor can add ## section titles during editing.');
  }

  if (!PRIMARY_SECTIONS.has(text(value.primary_section))) errors.push('Primary section is not a canonical Anyways section.');
  if (!STORY_FORMS.has(text(value.story_form || 'meanwhile'))) errors.push('Story form is not a canonical Anyways story form.');

  if (!Array.isArray(value.sources) || value.sources.length < 1 || value.sources.length > 20) {
    errors.push('Sources must contain between 1 and 20 records.');
  } else {
    value.sources.forEach((source, index) => {
      if (!validHttpUrl(source?.url || source?.canonical_url)) errors.push('Source ' + (index + 1) + ' needs a valid HTTP(S) URL.');
      if (!text(source?.title)) errors.push('Source ' + (index + 1) + ' needs a title.');
      if (!text(source?.used_for)) warnings.push('Source ' + (index + 1) + ' does not explain what it was used for.');
    });
  }

  if (value.claims !== undefined && !Array.isArray(value.claims)) errors.push('Claims must be an array when supplied.');
  for (const [index, claim] of (value.claims || []).entries()) {
    if (!text(claim?.claim)) errors.push('Claim ' + (index + 1) + ' needs text.');
    if (!CLAIM_STATUSES.has(text(claim?.status))) errors.push('Claim ' + (index + 1) + ' has an invalid status.');
    if (!Array.isArray(claim?.source_indexes) || !claim.source_indexes.length) {
      warnings.push('Claim ' + (index + 1) + ' has no source mapping and will need editorial review.');
    } else if (Array.isArray(value.sources)) {
      for (const sourceIndex of claim.source_indexes) {
        if (!Number.isInteger(sourceIndex) || sourceIndex < 1 || sourceIndex > value.sources.length) {
          errors.push('Claim ' + (index + 1) + ' references an invalid source index.');
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    metrics: {
      body_words: bodyWords,
      inline_source_link_count: bodyLinks.length,
      source_count: Array.isArray(value.sources) ? value.sources.length : 0,
      contract_version: HERMES_EDITORIAL_CONTRACT_VERSION
    }
  };
}
