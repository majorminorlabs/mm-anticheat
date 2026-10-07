import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  IMAGE_RIGHTS_POLICY,
  MAX_STORY_IMAGE_BYTES,
  MAX_STORY_IMAGE_BATCH,
  PHOTO_PERMISSION_OPTIONS,
  STORY_MEDIA_BUCKET,
  imageIsPublishable,
  imageRightsPayload,
  normalizeImageRightsWorkflow,
  presentationForSave,
  suggestedCreditLine,
  storyMediaPath,
  validateImageUrl,
  validateImageRightsWorkflow,
  validateStoryImage,
  validateStoryImageBatch
} from '../src/newsroom-media.mjs';
import { validateImageRights } from '../src/image-rights-policy.mjs';

const image = (overrides = {}) => ({ name: 'My Photo.JPG', type: 'image/jpeg', size: 1024, ...overrides });
const valid = (overrides = {}) => ({
  file: image(),
  altText: 'A reporter holding a notebook outside city hall.',
  rightsRecord: {
    provider: 'wikimedia_commons',
    source_page_url: 'https://commons.wikimedia.org/wiki/File:Example.jpg',
    original_file_url: 'https://upload.wikimedia.org/example.jpg',
    creator: 'Example photographer',
    license_code: 'cc_by',
    license_url: 'https://creativecommons.org/licenses/by/4.0/',
    commercial_use_allowed: true,
    modification_allowed: true,
    verification_method: 'wikimedia_file_page',
    verification_timestamp: '2026-07-30T12:00:00.000Z',
    source_metadata: { license: 'CC BY 4.0', file_page: 'Example.jpg' }
  },
  ...overrides
});

test('photo intake accepts a bounded batch before per-photo validation', () => {
  assert.equal(validateStoryImageBatch([image(), image({ name: 'Second.webp', type: 'image/webp' })]), '');
  assert.match(validateStoryImageBatch([]), /one or more/);
  assert.match(validateStoryImageBatch(Array.from({ length: MAX_STORY_IMAGE_BATCH + 1 }, () => image())), /no more than/);
});

test('photo intake validates the file while optional metadata stays optional', () => {
  assert.equal(validateStoryImage(valid()), '');
  assert.match(validateStoryImage(valid({ file: image({ type: 'image/svg+xml' }) })), /AVIF, JPEG, PNG, or WebP/);
  assert.match(validateStoryImage(valid({ file: image({ size: MAX_STORY_IMAGE_BYTES + 1 }) })), /10 MB/);
  assert.equal(validateStoryImage(valid({ altText: '' })), '');
  assert.equal(validateStoryImage(valid({ rightsRecord: { ...valid().rightsRecord, creator: '' } })), '');
});

test('photo permission status and image URL validation are bounded', () => {
  assert.deepEqual(PHOTO_PERMISSION_OPTIONS.map(option => option.label), ['Owned by us', 'Permission granted', 'Licensed or approved source']);
  assert.equal(validateImageUrl('https://example.com/image.jpg'), '');
  assert.match(validateImageUrl('javascript:alert(1)'), /valid image URL/);
  assert.match(validateImageUrl('not a url'), /valid image URL/);
});

test('each editor-facing rights status has focused conditional validation', () => {
  const base = valid().rightsRecord;
  const cases = [
    ['staff_owned', {}, true],
    ['licensed', { rights_details: { rights_holder: 'Photo agency', usage_restrictions: 'Web editorial only', proof_url: 'https://example.com/license' } }, true],
    ['permission_granted', { rights_details: { rights_holder: 'Photographer', permission_contact: 'photo@example.com', permission_date: '2026-07-30', usage_restrictions: 'One story', proof_url: 'https://example.com/permission' } }, true],
    ['public_domain', { rights_details: { public_domain_basis: 'U.S. federal government work' } }, true],
    ['creative_commons', { rights_details: { required_attribution: 'Example photographer, CC BY 4.0' } }, true],
    ['not_verified', {}, true]
  ];
  for (const [rights_basis, override, expected] of cases) {
    assert.equal(validateImageRightsWorkflow({ ...base, rights_basis, ...override }).valid, expected, rights_basis);
  }
  assert.match(validateImageRightsWorkflow({ ...base, rights_basis: 'licensed', rights_details: {} }).message, /Rights holder/);
  assert.match(validateImageRightsWorkflow({ ...base, rights_basis: 'permission_granted', rights_details: { rights_holder: 'Photographer' } }).message, /Permission contact/);
  assert.match(validateImageRightsWorkflow({ ...base, rights_basis: 'public_domain', rights_details: {} }).message, /Public-domain basis/);
  assert.match(validateImageRightsWorkflow({ ...base, rights_basis: 'creative_commons', rights_details: {} }).message, /Required attribution/);
});

test('legacy rights metadata survives workflow normalization and hidden fields remain in the payload', () => {
  const legacy = normalizeImageRightsWorkflow({ rights_note: 'Contract stored in the photo archive.', rights_details: { rights_holder: 'Archive owner', permission_contact: 'editor@example.com' } });
  assert.equal(legacy.rights_holder, 'Archive owner');
  assert.equal(legacy.permission_contact, 'editor@example.com');
  assert.equal(legacy.internal_rights_notes, 'Contract stored in the photo archive.');
  const payload = imageRightsPayload({ ...valid().rightsRecord, rights_basis: 'licensed', rights_details: legacy, editorial_approved: true });
  assert.equal(payload.rights_details.permission_contact, 'editor@example.com');
  assert.equal(payload.editorial_approved, true);
});

test('photo rights payload uses database-safe nullable timestamps', () => {
  const withoutTimestamp = imageRightsPayload({ ...valid().rightsRecord, verification_timestamp: '' });
  assert.equal(withoutTimestamp.verification_timestamp, null);

  const withTimestamp = imageRightsPayload({ ...valid().rightsRecord, verification_timestamp: '2026-08-04T12:34:56.000Z' });
  assert.equal(withTimestamp.verification_timestamp, '2026-08-04T12:34:56.000Z');

  const malformed = imageRightsPayload({ ...valid().rightsRecord, verification_timestamp: 'not-a-timestamp' });
  assert.equal(malformed.verification_timestamp, null);

  const withoutMetadata = imageRightsPayload({ ...valid().rightsRecord, source_metadata: null });
  assert.deepEqual(withoutMetadata.source_metadata, {});

  const malformedMetadata = imageRightsPayload({ ...valid().rightsRecord, source_metadata: 'not-json' });
  assert.deepEqual(malformedMetadata.source_metadata, {});
});

test('editorial approval is separate from clearance and not verified images cannot publish without an override', () => {
  assert.equal(imageIsPublishable({ rights_status: 'approved', rights_basis: 'staff_owned', editorial_approved: false }), true);
  assert.equal(imageIsPublishable({ rights_status: 'metadata_incomplete', rights_basis: 'staff_owned', editorial_approved: true }), false);
  assert.equal(imageIsPublishable({ rights_status: 'approved', rights_basis: 'not_verified', editorial_approved: true }), false);
  assert.equal(imageIsPublishable({ rights_status: 'approved', rights_basis: 'not_verified', rights_override_approved_at: '2026-07-30T12:00:00Z' }), true);
  assert.equal(suggestedCreditLine({ creator: 'Jane Doe', rights_details: { rights_holder: 'Photo agency' } }), 'Jane Doe / Photo agency');
});

test('rights policy automatically approves every allowed license and records the approving rule', () => {
  for (const license_code of Object.keys(IMAGE_RIGHTS_POLICY.allowedLicenses)) {
    const decision = validateImageRights({ ...valid().rightsRecord, license_code }, { now: '2026-07-30T12:00:00.000Z' });
    assert.equal(decision.status, 'approved', license_code);
    assert.equal(decision.audit.rule, 'approved_provider_license_and_metadata', license_code);
  }
});

test('rights policy rejects NC, ND, all-rights-reserved, social, news, direct-CDN, and incomplete records', () => {
  const record = valid().rightsRecord;
  for (const license_code of ['cc_by_nc', 'cc_by_nd']) {
    assert.equal(validateImageRights({ ...record, license_code }).audit.rule, 'noncommercial_or_no_derivatives_license');
  }
  assert.equal(validateImageRights({ ...record, license_code: 'all_rights_reserved' }).audit.rule, 'license_not_allowed');
  assert.equal(validateImageRights({ ...record, source_page_url: 'https://instagram.com/example' }).audit.rule, 'social_media_not_allowed');
  assert.equal(validateImageRights({ ...record, source_page_url: 'https://www.theverge.com/example' }).audit.rule, 'source_page_not_from_approved_provider');
  assert.equal(validateImageRights({ ...record, original_file_url: 'https://cdn.example.com/example.jpg' }).audit.rule, 'original_file_not_from_approved_provider');
  assert.equal(validateImageRights({ ...record, license_url: '' }).status, 'metadata_incomplete');
  assert.equal(validateImageRights({ ...record, source_metadata: { rights_ambiguous: true } }).status, 'manual_review');
});

test('generated editorial illustrations are credited and cannot be framed as documentary images', () => {
  const record = {
    ...valid().rightsRecord,
    provider: 'generated_editorial_illustration',
    source_page_url: 'https://anyways.media/newsroom/media/example',
    original_file_url: 'https://cdn.anyways.media/generated/example.png',
    license_code: 'cc0',
    license_url: 'https://creativecommons.org/publicdomain/zero/1.0/',
    verification_method: 'generated_editorial_illustration',
    source_metadata: { prompt_version: 'v1', documentary: false }
  };
  assert.equal(validateImageRights(record).creditLine, 'Illustration: Anyways');
  assert.equal(validateImageRights({ ...record, source_metadata: { documentary: true } }).audit.rule, 'generated_images_cannot_be_documentary');
});

test('story photo paths are user-scoped and normalize the filename', () => {
  assert.equal(STORY_MEDIA_BUCKET, 'story-media');
  assert.equal(
    storyMediaPath('user-1', image(), 'random-1'),
    'user-1/random-1-my-photo.jpg'
  );
});

test('saved presentation keeps render metadata but strips the private rights note', () => {
  const saved = presentationForSave({
    hero: {
      id: 'media:1',
      mediaId: '1',
      public_url: 'https://example.com/photo.jpg',
      alt_text: 'Photo',
      rights_status: 'approved',
      rights_note: 'Private contract details',
      source_url: 'https://internal.example/license'
    }
  });
  assert.equal(saved.hero.mediaId, '1');
  assert.equal(saved.hero.alt_text, 'Photo');
  assert.equal(saved.hero.rights_note, undefined);
  assert.equal(saved.hero.source_url, undefined);
});

test('saved presentation keeps multiple detours and a legacy first-card alias', () => {
  const saved = presentationForSave({ detours: [
    { id: 'detour-1', label: 'Context', text: 'The first card.', afterBlock: 0 },
    { id: 'detour-2', label: 'A wider question', text: 'The second card.', afterBlock: 2 }
  ] });
  assert.equal(saved.detours.length, 2);
  assert.equal(saved.detours[1].afterBlock, 2);
  assert.equal(saved.detour.label, 'Context');
});

test('story-media migrations create a guarded public bucket and deterministic server-side rights checks', () => {
  const migration = fs.readFileSync(new URL('../supabase/migrations/20260729100000_story_media_uploads.sql', import.meta.url), 'utf8');
  const gate = fs.readFileSync(new URL('../supabase/migrations/20260730030000_deterministic_image_rights_gate.sql', import.meta.url), 'utf8');
  const workflow = fs.readFileSync(new URL('../supabase/migrations/20260730040000_compact_image_rights_workflow.sql', import.meta.url), 'utf8');
  assert.match(migration, /insert into storage\.buckets/);
  assert.match(migration, /file_size_limit,\s*allowed_mime_types/);
  assert.match(migration, /storage\.foldername\(name\)/);
  assert.match(migration, /owner_id = auth\.uid\(\)::text/);
  assert.match(gate, /image_rights_audit/);
  assert.match(gate, /rights_status = 'approved'/);
  assert.match(gate, /noncommercial_or_no_derivatives_license/);
  assert.match(gate, /generated_images_cannot_be_documentary/);
  assert.match(workflow, /rights_basis/);
  assert.match(workflow, /editorial_approved/);
  assert.match(workflow, /editorial_rights_not_verified/);
  assert.match(workflow, /editorial_rights_workflow_incomplete/);
  assert.match(workflow, /rights_override_approved_at/);
});

test('article preview uses a viewport-height iframe instead of expanding to document height', () => {
  const appSource = fs.readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../public/design/design.css', import.meta.url), 'utf8');
  assert.doesNotMatch(appSource, /previewCanvas\.style\.height/);
  assert.match(appSource, /previousScroll/);
  assert.match(appSource, /data-add-detour/);
  assert.match(appSource, /data-detour-list/);
  assert.doesNotMatch(appSource, /preview-detour-visible/);
  assert.match(css, /\.article-preview-canvas\s*\{[^}]*height:\s*100%/s);
  assert.match(css, /\.article-preview-stage\s*\{[^}]*overflow:\s*hidden/s);
});

test('article editor keeps the primary photo workflow compact and attaches media immediately', () => {
  const appSource = fs.readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8');
  const primaryPhotoForm = appSource.slice(appSource.indexOf('<form id="photo-upload-form"'), appSource.indexOf('<dialog class="photo-details-dialog"'));
  assert.match(appSource, /id="photo-file" name="file" type="file"/);
  assert.doesNotMatch(appSource, /id="photo-file"[^>]*multiple/);
  assert.match(appSource, /name="permission_status"[^>]*required/);
  assert.doesNotMatch(primaryPhotoForm, /(?:name|id)="(?:mime_type|file_size|width|height|storage_path|storage_url|public_url|checksum|created_at|updated_at|provider|source_metadata|internal_id)"/);
  assert.match(appSource, /function randomId()/);
  assert.match(appSource, /storyMediaPath\(p\.id, file, randomId\(\)\)/);
  assert.match(appSource, /sb\.storage\.from\(STORY_MEDIA_BUCKET\)\.upload/);
  assert.match(appSource, /story_id: id/);
  assert.match(appSource, /width: dimensions\?\.width/);
  assert.match(appSource, /mimeType: file\.type/);
  assert.match(appSource, /addToMediaLibrary\(mediaItem\(savedMedia/);
  assert.match(appSource, /data-photo-upload-progress/);
  assert.match(appSource, /data-toggle-photo-url/);
  assert.match(appSource, /id="photo-url-form"/);
});

test('photo upload errors preserve the form and existing media records still render', () => {
  const appSource = fs.readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8');
  assert.match(appSource, /could not be uploaded/);
  assert.match(appSource, /photoUploadForm\.reset\(\)/);
  assert.match(appSource, /const mediaLibrary = \[/);
  assert.match(appSource, /mediaRows \|\| \[\]/);
  assert.match(appSource, /renderAttachedMedia\(\)/);
  assert.match(appSource, /altText.*defaultImageAlt|defaultImageAlt\(filename/);
  assert.match(appSource, /withPhotoTimeout\(uploadRequest, PHOTO_UPLOAD_TIMEOUT_MS/);
  assert.match(appSource, /abortSignal\(controller\.signal\)/);
  assert.match(appSource, /dimensions\.timedOut/);
});

test('article editor lets editors record clearance for an already-attached photo', () => {
  const appSource = fs.readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8');
  const migration = fs.readFileSync(new URL('../supabase/migrations/20260729233000_existing_story_media_rights.sql', import.meta.url), 'utf8');
  assert.match(appSource, /data-edit-photo/);
  assert.match(appSource, /data-photo-details-dialog/);
  assert.match(appSource, /Save photo details/);
  assert.match(appSource, /from\('media'\)\.update\(\{ caption: String\(values\.caption\)\.trim\(\)/);
  assert.match(appSource, /from\('image_candidates'\)\.update\(\{ caption: String\(values\.caption\)\.trim\(\)/);
  assert.match(appSource, /source_metadata/);
  assert.match(appSource, /imageRightsPayload/);
  assert.match(migration, /grant update \(rights_status, rights_note, source_url\)/);
  assert.match(migration, /using \(public\.is_editor\(\)\)/);
});

test('temporary image rights warning mode does not keep the story approval hard stop', () => {
  const appSource = fs.readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8');
  const migration = fs.readFileSync(new URL('../supabase/migrations/20260804220000_disable_image_publish_rights_gate.sql', import.meta.url), 'utf8');
  assert.doesNotMatch(appSource, /hasRightsBlocker/);
  assert.match(migration, /select true;/);
});

test('edition covers use the selected presentation hero before the legacy media pointer', () => {
  const appSource = fs.readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8');
  assert.match(appSource, /'hero_media_id', 'presentation'/);
  assert.match(appSource, /const candidate = s\.presentation\?\.hero \|\| s\.hero_media;/);
  assert.match(appSource, /candidate\.public_url \|\| candidate\.url \|\| candidate\.original_url/);
});
