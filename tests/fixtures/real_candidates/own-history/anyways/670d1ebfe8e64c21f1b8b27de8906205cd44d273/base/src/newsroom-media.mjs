export const STORY_MEDIA_BUCKET = 'story-media';
export const MAX_STORY_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_STORY_IMAGE_BATCH = 12;

export const STORY_IMAGE_TYPES = Object.freeze({
  'image/avif': 'avif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp'
});

import { IMAGE_RIGHTS_POLICY, IMAGE_RIGHTS_STATUSES, generatedCreditLine, validateImageRights } from './image-rights-policy.mjs';

export { IMAGE_RIGHTS_POLICY, IMAGE_RIGHTS_STATUSES };

export const IMAGE_PROVIDER_OPTIONS = Object.freeze(Object.entries(IMAGE_RIGHTS_POLICY.allowedProviders)
  .map(([value, rule]) => ({ value, label: rule.label })));
export const IMAGE_LICENSE_OPTIONS = Object.freeze(Object.entries(IMAGE_RIGHTS_POLICY.allowedLicenses)
  .map(([value, rule]) => ({ value, label: rule.label, url: rule.url })));

export function validateStoryImage({ file, altText, rightsRecord = {} }) {
  if (!file) return 'Choose an image file.';
  if (!STORY_IMAGE_TYPES[file.type]) return 'Use an AVIF, JPEG, PNG, or WebP image.';
  if (!Number.isFinite(file.size) || file.size <= 0 || file.size > MAX_STORY_IMAGE_BYTES) return 'Images must be 10 MB or smaller.';
  if (!String(altText || '').trim()) return 'Add alt text before uploading.';
  const decision = validateImageRights(rightsRecord);
  if (!decision.approved) return `Image rights are ${decision.status.replace(/_/g, ' ')}: ${decision.audit.detail}`;
  return '';
}

export function imageRightsPayload(record = {}, decision = validateImageRights(record)) {
  return {
    provider: record.provider,
    source_page_url: record.source_page_url,
    original_file_url: record.original_file_url,
    creator: record.creator,
    license_code: record.license_code,
    license_url: record.license_url,
    credit_line: generatedCreditLine(record),
    commercial_use_allowed: record.commercial_use_allowed === true,
    modification_allowed: record.modification_allowed === true,
    verification_method: record.verification_method,
    verification_timestamp: record.verification_timestamp,
    source_metadata: record.source_metadata,
    rights_status: decision.status,
    rights_audit: decision.audit
  };
}

export function validateStoryImageBatch(files) {
  const batch = Array.from(files || []);
  if (!batch.length) return 'Choose one or more image files.';
  if (batch.length > MAX_STORY_IMAGE_BATCH) return `Upload no more than ${MAX_STORY_IMAGE_BATCH} photos at a time.`;
  return '';
}

export function storyMediaPath(userId, filename, randomId) {
  const extension = STORY_IMAGE_TYPES[String(filename?.type || '')] || 'jpg';
  const base = String(filename?.name || 'photo')
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64) || 'photo';
  return `${userId}/${randomId}-${base}.${extension}`;
}

function publicationImage(image) {
  if (!image) return null;
  const allowed = [
    'id', 'mediaId', 'candidateImageId', 'sourceId', 'public_url', 'original_url',
    'alt_text', 'caption', 'credit', 'width', 'height', 'rights_status', 'provider',
    'crop', 'focalX', 'focalY', 'afterBlock', 'layout', 'label'
  ];
  return Object.fromEntries(allowed.filter(key => image[key] !== undefined).map(key => [key, image[key]]));
}

export function presentationForSave(value = {}) {
  return {
    composition: value.composition || 'auto',
    accent: value.accent || 'auto',
    hero: publicationImage(value.hero),
    detour: {
      visible: Boolean(value.detour?.visible),
      label: String(value.detour?.label || 'The detour'),
      text: String(value.detour?.text || ''),
      afterBlock: Math.max(0, Number(value.detour?.afterBlock) || 0)
    },
    inlineImages: Array.isArray(value.inlineImages) ? value.inlineImages.map(publicationImage).filter(Boolean) : []
  };
}
