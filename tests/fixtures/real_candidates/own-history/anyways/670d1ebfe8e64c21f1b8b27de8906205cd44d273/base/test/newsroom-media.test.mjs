import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  IMAGE_RIGHTS_POLICY,
  MAX_STORY_IMAGE_BYTES,
  MAX_STORY_IMAGE_BATCH,
  STORY_MEDIA_BUCKET,
  presentationForSave,
  storyMediaPath,
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

test('new-story photo validation requires a safe image and an approved deterministic rights record', () => {
  assert.equal(validateStoryImage(valid()), '');
  assert.match(validateStoryImage(valid({ file: image({ type: 'image/svg+xml' }) })), /AVIF, JPEG, PNG, or WebP/);
  assert.match(validateStoryImage(valid({ file: image({ size: MAX_STORY_IMAGE_BYTES + 1 }) })), /10 MB/);
  assert.match(validateStoryImage(valid({ altText: '' })), /alt text/);
  assert.match(validateStoryImage(valid({ rightsRecord: { ...valid().rightsRecord, creator: '' } })), /metadata incomplete/);
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

test('story-media migrations create a guarded public bucket and deterministic server-side rights checks', () => {
  const migration = fs.readFileSync(new URL('../supabase/migrations/20260729100000_story_media_uploads.sql', import.meta.url), 'utf8');
  const gate = fs.readFileSync(new URL('../supabase/migrations/20260730030000_deterministic_image_rights_gate.sql', import.meta.url), 'utf8');
  assert.match(migration, /insert into storage\.buckets/);
  assert.match(migration, /file_size_limit,\s*allowed_mime_types/);
  assert.match(migration, /storage\.foldername\(name\)/);
  assert.match(migration, /owner_id = auth\.uid\(\)::text/);
  assert.match(gate, /image_rights_audit/);
  assert.match(gate, /rights_status = 'approved'/);
  assert.match(gate, /noncommercial_or_no_derivatives_license/);
  assert.match(gate, /generated_images_cannot_be_documentary/);
});

test('article preview uses a viewport-height iframe instead of expanding to document height', () => {
  const appSource = fs.readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../public/design/design.css', import.meta.url), 'utf8');
  assert.doesNotMatch(appSource, /previewCanvas\.style\.height/);
  assert.match(appSource, /previousScroll/);
  assert.match(css, /\.article-preview-canvas\s*\{[^}]*height:\s*100%/s);
  assert.match(css, /\.article-preview-stage\s*\{[^}]*overflow:\s*hidden/s);
});

test('article editor stages batch metadata and hero or body placement', () => {
  const appSource = fs.readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8');
  assert.match(appSource, /type="file"[^>]*multiple/);
  assert.match(appSource, /data-photo-batch-staging/);
  assert.match(appSource, /value="hero">Hero photo/);
  assert.match(appSource, /value="body">Article body/);
  assert.match(appSource, /uploadButton\.textContent = `Uploading \$\{index \+ 1\} of \$\{entries\.length\}/);
  assert.match(appSource, /presentationDraft\.inlineImages\.push/);
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

test('edition covers use the selected presentation hero before the legacy media pointer', () => {
  const appSource = fs.readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8');
  assert.match(appSource, /'hero_media_id', 'presentation'/);
  assert.match(appSource, /const candidate = s\.presentation\?\.hero \|\| s\.hero_media;/);
  assert.match(appSource, /candidate\.public_url \|\| candidate\.url \|\| candidate\.original_url/);
});
