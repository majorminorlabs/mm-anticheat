-- Allow newsroom article media to include animated GIFs and bounded videos.
-- Existing image records and presentation JSON remain unchanged.
begin;

update storage.buckets
set
  file_size_limit = 26214400,
  allowed_mime_types = array[
    'image/avif',
    'image/gif',
    'image/jpeg',
    'image/png',
    'image/webp',
    'video/mp4',
    'video/webm'
  ]
where id = 'story-media';

commit;
