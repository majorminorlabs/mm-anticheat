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

// This is the editor-facing explanation of how a photo was obtained. It is
// deliberately separate from rights_status, which remains the deterministic
// publication decision made by the rights gate.
export const IMAGE_RIGHTS_BASIS_OPTIONS = Object.freeze([
  { value: 'staff_owned', label: 'Staff-owned' },
  { value: 'licensed', label: 'Licensed' },
  { value: 'permission_granted', label: 'Permission granted' },
  { value: 'public_domain', label: 'Public domain' },
  { value: 'creative_commons', label: 'Creative Commons' },
  { value: 'not_verified', label: 'Not verified' }
]);

export const PHOTO_PERMISSION_OPTIONS = Object.freeze([
  { value: 'staff_owned', label: 'Owned by us' },
  { value: 'permission_granted', label: 'Permission granted' },
  { value: 'licensed', label: 'Licensed or approved source' }
]);

export const IMAGE_RIGHTS_BASIS_VALUES = Object.freeze(IMAGE_RIGHTS_BASIS_OPTIONS.map(option => option.value));

const text = value => String(value || '').trim();
const nullableJsonObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const nullableTimestamp = value => {
  const timestamp = text(value);
  if (!timestamp) return null;
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
};
const validUrl = value => {
  try {
    const url = new URL(text(value));
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
};

export function normalizeImageRightsWorkflow(record = {}) {
  const details = record.rights_details && typeof record.rights_details === 'object' && !Array.isArray(record.rights_details)
    ? record.rights_details : {};
  const basis = IMAGE_RIGHTS_BASIS_VALUES.includes(record.rights_basis) ? record.rights_basis : 'not_verified';
  return {
    rights_basis: basis,
    rights_holder: text(details.rights_holder),
    permission_contact: text(details.permission_contact),
    permission_date: text(details.permission_date),
    usage_restrictions: text(details.usage_restrictions),
    expiration_date: text(details.expiration_date),
    proof_url: text(details.proof_url),
    public_domain_basis: text(details.public_domain_basis),
    required_attribution: text(details.required_attribution),
    internal_rights_notes: text(details.internal_rights_notes || record.rights_note),
    editorial_approved: record.editorial_approved === true
  };
}

export function validateImageRightsWorkflow(record = {}) {
  const workflow = normalizeImageRightsWorkflow(record);
  const missing = label => ({ valid: false, message: `${label} is required for this rights status.` });
  const proof = label => validUrl(workflow.proof_url) ? { valid: true, message: '' } : missing(label);
  switch (workflow.rights_basis) {
    case 'licensed':
      if (!workflow.rights_holder) return missing('Rights holder');
      if (!text(record.license_code)) return missing('License type');
      if (!workflow.usage_restrictions) return missing('Usage restrictions');
      return proof('Proof of license URL or file');
    case 'permission_granted':
      if (!workflow.rights_holder) return missing('Rights holder');
      if (!workflow.permission_contact) return missing('Permission contact');
      if (!workflow.permission_date) return missing('Permission date');
      if (!workflow.usage_restrictions) return missing('Usage restrictions');
      return proof('Proof of permission URL or file');
    case 'public_domain':
      if (!validUrl(record.source_page_url)) return missing('Source page URL');
      return workflow.public_domain_basis ? { valid: true, message: '' } : missing('Public-domain basis or note');
    case 'creative_commons':
      if (!text(record.creator)) return missing('Creator');
      if (!text(record.license_code)) return missing('License type');
      if (!validUrl(record.license_url)) return missing('License URL');
      return workflow.required_attribution ? { valid: true, message: '' } : missing('Required attribution');
    case 'not_verified':
      return { valid: true, message: 'Not verified photos are saved for editorial work but cannot be published.' };
    default:
      return { valid: true, message: '' };
  }
}

export function suggestedCreditLine(record = {}) {
  const workflow = normalizeImageRightsWorkflow(record);
  if (text(record.creator) && workflow.rights_holder && text(record.creator) !== workflow.rights_holder) return `${text(record.creator)} / ${workflow.rights_holder}`;
  return text(record.creator) || workflow.rights_holder;
}

export function imageIsPublishable(record = {}) {
  return record.rights_status === 'approved' && (record.rights_basis !== 'not_verified' || Boolean(record.rights_override_approved_at));
}

export function validateStoryImage({ file, altText, rightsRecord = {} }) {
  if (!file) return 'Choose an image file.';
  if (!STORY_IMAGE_TYPES[file.type]) return 'Use an AVIF, JPEG, PNG, or WebP image.';
  if (!Number.isFinite(file.size) || file.size <= 0 || file.size > MAX_STORY_IMAGE_BYTES) return 'Images must be 10 MB or smaller.';
  return '';
}

export function validateImageUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 2048) return 'Enter a valid image URL.';
    return '';
  } catch {
    return 'Enter a valid image URL.';
  }
}

export function imageRightsPayload(record = {}, decision = validateImageRights(record)) {
  const workflow = normalizeImageRightsWorkflow(record);
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
    verification_timestamp: nullableTimestamp(record.verification_timestamp),
    source_metadata: nullableJsonObject(record.source_metadata),
    rights_basis: workflow.rights_basis,
    rights_details: {
      rights_holder: workflow.rights_holder,
      permission_contact: workflow.permission_contact,
      permission_date: workflow.permission_date,
      usage_restrictions: workflow.usage_restrictions,
      expiration_date: workflow.expiration_date,
      proof_url: workflow.proof_url,
      public_domain_basis: workflow.public_domain_basis,
      required_attribution: workflow.required_attribution,
      internal_rights_notes: workflow.internal_rights_notes
    },
    editorial_approved: workflow.editorial_approved,
    rights_note: workflow.internal_rights_notes || null,
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
    'crop', 'fit', 'focalX', 'focalY', 'afterBlock', 'layout', 'label'
  ];
  return Object.fromEntries(allowed.filter(key => image[key] !== undefined).map(key => [key, image[key]]));
}

export function presentationForSave(value = {}) {
  const rawDetours = Array.isArray(value.detours)
    ? value.detours
    : value.detour && typeof value.detour === 'object' ? [value.detour] : [];
  const detours = rawDetours.filter(item => item && typeof item === 'object').map((item, index) => ({
    id: String(item.id || `detour-${index + 1}`),
    visible: item.visible !== false,
    label: String(item.label || 'The detour'),
    text: String(item.text || '').trim(),
    afterBlock: Math.max(0, Number(item.afterBlock) || 0)
  }));
  return {
    composition: value.composition || 'auto',
    accent: value.accent || 'auto',
    hero: publicationImage(value.hero),
    // Keep the first-card alias for older readers while the array is the
    // canonical representation for new and updated stories.
    detour: detours[0] || { visible: false, label: 'The detour', text: '', afterBlock: 1 },
    detours,
    inlineImages: Array.isArray(value.inlineImages) ? value.inlineImages.map(publicationImage).filter(Boolean) : []
  };
}
