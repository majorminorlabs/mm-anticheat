-- Keep the strict redirect-host safety check, but store the verified canonical
-- feed URL for sources whose old locator crossed a www or registrable-host
-- boundary. These sources were already active; this does not activate any
-- staged or historical source.
update public.source_registry
set
  handle_or_url = case name
    when 'Web3 Is Going Just Great RSS' then 'https://www.web3isgoinggreat.com/feed.xml'
    when 'Coin Center RSS' then 'https://coincenter.org/feed'
    when 'Blockworks RSS' then 'https://blockworks.com/feed'
    else handle_or_url
  end,
  identity_key = case name
    when 'Web3 Is Going Just Great RSS' then 'url:https://www.web3isgoinggreat.com/feed.xml'
    when 'Coin Center RSS' then 'url:https://coincenter.org/feed'
    when 'Blockworks RSS' then 'url:https://blockworks.com/feed'
    else identity_key
  end,
  ingestion_status = 'ready',
  ingestion_failure_count = 0,
  ingestion_next_eligible_at = now(),
  last_error = null,
  ingestion_blocker = null,
  ingestion_etag = null,
  ingestion_last_modified = null,
  ingestion_validated_at = null,
  ingestion_validation_url = null,
  updated_at = now()
where name in (
  'CFTC Enforcement RSS',
  'Web3 Is Going Just Great RSS',
  'Coin Center RSS',
  'Blockworks RSS'
)
and active = true;
