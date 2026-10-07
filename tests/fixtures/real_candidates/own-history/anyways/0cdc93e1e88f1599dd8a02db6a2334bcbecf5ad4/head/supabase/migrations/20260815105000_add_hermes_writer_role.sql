-- Add the Hermes Auth profile role in its own migration. PostgreSQL cannot
-- use a newly-added enum value until the transaction that adds it commits.
alter type public.newsroom_role add value if not exists 'hermes_writer';
