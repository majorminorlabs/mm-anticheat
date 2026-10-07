-- Source Graph V3: add the high-fit reporting, trade, security, policy, and
-- event feeds from the Anyways source audit. This migration keeps source
-- discovery separate from verification and does not write stories or jobs.
begin;

alter table public.source_registry
  add column if not exists pipeline_role text not null default 'discovery',
  add column if not exists editorial_fit numeric(2,1) not null default 3.0;

alter table public.source_registry drop constraint if exists source_registry_pipeline_role_check;
alter table public.source_registry add constraint source_registry_pipeline_role_check
  check (pipeline_role in ('discovery', 'verification', 'both', 'lead_only'));
alter table public.source_registry drop constraint if exists source_registry_editorial_fit_check;
alter table public.source_registry add constraint source_registry_editorial_fit_check
  check (editorial_fit between 1.0 and 5.0);

create index if not exists source_registry_discovery_role_idx
  on public.source_registry(active, review_status, pipeline_role, editorial_fit desc, priority desc);

with candidates as (
  select * from jsonb_to_recordset($sources$
  [
    {"name":"DL News People & Culture RSS","handle_or_url":"https://www.dlnews.com/arc/outboundfeeds/rss/category/articles/people-culture/","platform":"rss","source_type":"rss","primary_class":"publication","description":"DL News reporting on the people, culture, brands, and communities around digital assets.","priority":9,"trust_level":"reliable","primary_sections":["culture","digital-collectibles","memecoins"],"topic_tags":["people","culture","brands","NFTs","memecoins"],"chain_tags":["ethereum","solana"],"project_tags":[],"public_display_name":"DL News","editorial_title":"DL News People & Culture","identity_key":"url:https://www.dlnews.com/arc/outboundfeeds/rss/category/articles/people-culture/","poll_interval_seconds":1800,"pipeline_role":"discovery","editorial_fit":4.5},
    {"name":"DL News Web3 RSS","handle_or_url":"https://www.dlnews.com/arc/outboundfeeds/rss/category/articles/web3/","platform":"rss","source_type":"rss","primary_class":"publication","description":"DL News reporting on Web3 products, people, consumer adoption, and unusual businesses.","priority":8,"trust_level":"reliable","primary_sections":["digital-collectibles","culture","products"],"topic_tags":["Web3","brands","consumer adoption","tokenization"],"chain_tags":["ethereum","solana","base"],"project_tags":[],"public_display_name":"DL News","editorial_title":"DL News Web3","identity_key":"url:https://www.dlnews.com/arc/outboundfeeds/rss/category/articles/web3/","poll_interval_seconds":1800,"pipeline_role":"discovery","editorial_fit":4.0},
    {"name":"DL News Regulation RSS","handle_or_url":"https://www.dlnews.com/arc/outboundfeeds/rss/category/articles/regulation/","platform":"rss","source_type":"rss","primary_class":"publication","description":"DL News reporting on regulation when it changes the behavior, risk, or power of crypto companies and users.","priority":8,"trust_level":"reliable","primary_sections":["markets","products","culture"],"topic_tags":["regulation","policy","enforcement","crypto companies"],"chain_tags":["ethereum","bitcoin"],"project_tags":[],"public_display_name":"DL News","editorial_title":"DL News Regulation","identity_key":"url:https://www.dlnews.com/arc/outboundfeeds/rss/category/articles/regulation/","poll_interval_seconds":1800,"pipeline_role":"discovery","editorial_fit":4.0},
    {"name":"Protos RSS","handle_or_url":"https://protos.com/feed/","platform":"rss","source_type":"rss","primary_class":"publication","description":"Investigative and skeptical crypto reporting focused on conflicts, scams, strange markets, and follow-the-money stories.","priority":9,"trust_level":"reliable","primary_sections":["markets","culture","memecoins"],"topic_tags":["investigations","scams","mysteries","conflicts","people"],"chain_tags":["ethereum","bitcoin","solana"],"project_tags":[],"public_display_name":"Protos","editorial_title":"Protos","identity_key":"url:https://protos.com/feed/","poll_interval_seconds":1200,"pipeline_role":"discovery","editorial_fit":4.5},
    {"name":"nft now RSS","handle_or_url":"https://nftnow.com/feed/","platform":"rss","source_type":"rss","primary_class":"publication","description":"NFT, digital-collectible, brand, artist, and Web3 culture reporting.","priority":9,"trust_level":"reliable","primary_sections":["digital-collectibles","culture","products"],"topic_tags":["NFTs","brands","artists","culture","events"],"chain_tags":["ethereum","solana","bitcoin"],"project_tags":[],"public_display_name":"nft now","editorial_title":"nft now","identity_key":"url:https://nftnow.com/feed/","poll_interval_seconds":1800,"pipeline_role":"discovery","editorial_fit":5.0},
    {"name":"NFT Plazas RSS","handle_or_url":"https://nftplazas.com/feed/","platform":"rss","source_type":"rss","primary_class":"publication","description":"NFT launches, partnerships, games, marketplaces, and digital-collectible culture.","priority":8,"trust_level":"useful_signal","primary_sections":["digital-collectibles","culture","products"],"topic_tags":["NFTs","brands","gaming","launches","events"],"chain_tags":["ethereum","solana","bitcoin"],"project_tags":[],"public_display_name":"NFT Plazas","editorial_title":"NFT Plazas","identity_key":"url:https://nftplazas.com/feed/","poll_interval_seconds":1800,"pipeline_role":"discovery","editorial_fit":4.5},
    {"name":"DappRadar Blog RSS","handle_or_url":"https://dappradar.com/blog/feed","platform":"rss","source_type":"rss","primary_class":"market_intelligence","description":"Consumer Web3 product usage, gaming, NFT, and decentralized-app trend reporting.","priority":8,"trust_level":"reliable","primary_sections":["digital-collectibles","products","markets"],"topic_tags":["dapps","NFTs","gaming","usage","consumer products"],"chain_tags":["ethereum","solana","polygon"],"project_tags":[],"public_display_name":"DappRadar","editorial_title":"DappRadar Blog","identity_key":"url:https://dappradar.com/blog/feed","poll_interval_seconds":3600,"pipeline_role":"both","editorial_fit":4.0},
    {"name":"Unchained RSS","handle_or_url":"https://unchainedcrypto.com/feed/","platform":"rss","source_type":"rss","primary_class":"publication","description":"Crypto reporting, interviews, investigations, and policy context for follow-up and corroboration.","priority":7,"trust_level":"reliable","primary_sections":["markets","culture","products"],"topic_tags":["crypto news","policy","people","investigations"],"chain_tags":["ethereum","bitcoin","solana"],"project_tags":[],"public_display_name":"Unchained","editorial_title":"Unchained","identity_key":"url:https://unchainedcrypto.com/feed/","poll_interval_seconds":3600,"pipeline_role":"discovery","editorial_fit":3.5},
    {"name":"Bloomberg Crypto RSS","handle_or_url":"https://feeds.bloomberg.com/crypto/news.rss","platform":"rss","source_type":"rss","primary_class":"publication","description":"Mainstream business and financial reporting when crypto crosses into markets, politics, and recognizable companies.","priority":7,"trust_level":"reliable","primary_sections":["markets","culture","products"],"topic_tags":["business","markets","politics","mainstream adoption"],"chain_tags":["bitcoin","ethereum"],"project_tags":[],"public_display_name":"Bloomberg","editorial_title":"Bloomberg Crypto","identity_key":"url:https://feeds.bloomberg.com/crypto/news.rss","poll_interval_seconds":3600,"pipeline_role":"discovery","editorial_fit":3.5},
    {"name":"Financial Times Crypto RSS","handle_or_url":"https://www.ft.com/crypto?format=rss","platform":"rss","source_type":"rss","primary_class":"publication","description":"Institutional, financial, and political context for crypto stories that reach mainstream power centers.","priority":7,"trust_level":"reliable","primary_sections":["markets","culture","products"],"topic_tags":["finance","institutions","politics","mainstream adoption"],"chain_tags":["bitcoin","ethereum"],"project_tags":[],"public_display_name":"Financial Times","editorial_title":"FT Crypto","identity_key":"url:https://www.ft.com/crypto?format=rss","poll_interval_seconds":3600,"pipeline_role":"discovery","editorial_fit":3.5},
    {"name":"CryptoSlate RSS","handle_or_url":"https://cryptoslate.com/feed/","platform":"rss","source_type":"rss","primary_class":"publication","description":"Broad crypto reporting used as a gap catcher, with strict novelty and duplication filters.","priority":6,"trust_level":"useful_signal","primary_sections":["markets","defi","chains","culture"],"topic_tags":["crypto news","DeFi","AI","new chains"],"chain_tags":["ethereum","solana","bitcoin","base"],"project_tags":[],"public_display_name":"CryptoSlate","editorial_title":"CryptoSlate","identity_key":"url:https://cryptoslate.com/feed/","poll_interval_seconds":1800,"pipeline_role":"discovery","editorial_fit":3.0},
    {"name":"Bankless RSS","handle_or_url":"https://www.bankless.com/rss/feed","platform":"rss","source_type":"rss","primary_class":"publication","description":"DeFi, crypto culture, AI, and thesis-driven reporting useful for context and follow-up angles.","priority":6,"trust_level":"useful_signal","primary_sections":["defi","culture","products"],"topic_tags":["DeFi","AI","culture","markets"],"chain_tags":["ethereum","solana","base"],"project_tags":[],"public_display_name":"Bankless","editorial_title":"Bankless","identity_key":"url:https://www.bankless.com/rss/feed","poll_interval_seconds":3600,"pipeline_role":"discovery","editorial_fit":3.5},
    {"name":"The Toy Book Trading Cards RSS","handle_or_url":"https://toybook.com/category/product-launches/trading-cards/feed/","platform":"rss","source_type":"rss","primary_class":"publication","description":"Toy, card, licensing, and retail reporting that can reveal mainstream collectible stories before crypto publications notice them.","priority":9,"trust_level":"reliable","primary_sections":["digital-collectibles","culture","products"],"topic_tags":["trading cards","Pokemon","sports cards","licensing","retail"],"chain_tags":["rwas"],"project_tags":[],"public_display_name":"The Toy Book","editorial_title":"The Toy Book Trading Cards","identity_key":"url:https://toybook.com/category/product-launches/trading-cards/feed/","poll_interval_seconds":10800,"pipeline_role":"discovery","editorial_fit":5.0},
    {"name":"The Toy Book Collectibles","handle_or_url":"https://toybook.com/category/product-launches/collectibles/","platform":"blog","source_type":"blog","primary_class":"publication","description":"Collectible, toy, licensing, and retail launches, including physical products with digital or Web3 ties.","priority":8,"trust_level":"reliable","primary_sections":["digital-collectibles","culture","products"],"topic_tags":["collectibles","licensing","retail","brands"],"chain_tags":["rwas"],"project_tags":[],"public_display_name":"The Toy Book","editorial_title":"The Toy Book Collectibles","identity_key":"url:https://toybook.com/category/product-launches/collectibles/","poll_interval_seconds":21600,"pipeline_role":"discovery","editorial_fit":5.0},
    {"name":"Sports Collectors Daily RSS","handle_or_url":"https://www.sportscollectorsdaily.com/feed/","platform":"rss","source_type":"rss","primary_class":"publication","description":"Sports-card, grading, collecting, auction, and licensing reporting for tokenized-card and collector stories.","priority":8,"trust_level":"reliable","primary_sections":["digital-collectibles","culture","markets"],"topic_tags":["sports cards","collecting","grading","auctions","licensing"],"chain_tags":["rwas"],"project_tags":[],"public_display_name":"Sports Collectors Daily","editorial_title":"Sports Collectors Daily","identity_key":"url:https://www.sportscollectorsdaily.com/feed/","poll_interval_seconds":10800,"pipeline_role":"discovery","editorial_fit":5.0},
    {"name":"PokéBeach RSS","handle_or_url":"https://www.pokebeach.com/forums/forum/-/index.rss","platform":"rss","source_type":"rss","primary_class":"publication","description":"Pokemon card, product, event, and collector reporting from a specialized upstream community.","priority":9,"trust_level":"reliable","primary_sections":["digital-collectibles","culture","products"],"topic_tags":["Pokemon","trading cards","collectors","events"],"chain_tags":["rwas"],"project_tags":[],"public_display_name":"PokéBeach","editorial_title":"PokéBeach","identity_key":"url:https://www.pokebeach.com/forums/forum/-/index.rss","poll_interval_seconds":3600,"pipeline_role":"discovery","editorial_fit":5.0},
    {"name":"PSA Article Library","handle_or_url":"https://www.psacard.com/articles","platform":"blog","source_type":"blog","primary_class":"official","description":"Primary collector-economy reporting on grading, authentication, record cards, fraud, and events.","priority":8,"trust_level":"official","primary_sections":["digital-collectibles","culture","markets"],"topic_tags":["grading","authentication","Pokemon","sports cards","collectibles"],"chain_tags":["rwas"],"project_tags":[],"public_display_name":"PSA","editorial_title":"PSA Articles","identity_key":"url:https://www.psacard.com/articles","poll_interval_seconds":21600,"pipeline_role":"both","editorial_fit":4.5},
    {"name":"CGC Cards News","handle_or_url":"https://www.cgccards.com/news/","platform":"blog","source_type":"blog","primary_class":"official","description":"Primary card authentication, grading, product, event, and collector-economy reporting.","priority":8,"trust_level":"official","primary_sections":["digital-collectibles","culture","markets"],"topic_tags":["grading","authentication","Pokemon","sports cards","collectibles"],"chain_tags":["rwas"],"project_tags":[],"public_display_name":"CGC Cards","editorial_title":"CGC Cards News","identity_key":"url:https://www.cgccards.com/news/","poll_interval_seconds":21600,"pipeline_role":"both","editorial_fit":4.5},
    {"name":"Bubblemaps Blog RSS","handle_or_url":"https://blog.bubblemaps.io/rss/","platform":"rss","source_type":"rss","primary_class":"investigator","description":"Onchain investigations, token concentration, insider clusters, and visual explanations of strange markets.","priority":9,"trust_level":"reliable","primary_sections":["memecoins","markets","culture"],"topic_tags":["onchain investigations","insider clusters","memecoins","rugs","visual data"],"chain_tags":["ethereum","solana","base"],"project_tags":[],"public_display_name":"Bubblemaps","editorial_title":"Bubblemaps","identity_key":"url:https://blog.bubblemaps.io/rss/","poll_interval_seconds":1800,"pipeline_role":"both","editorial_fit":5.0},
    {"name":"Bubblemaps Case Studies","handle_or_url":"https://bubblemaps.io/case-studies/","platform":"blog","source_type":"blog","primary_class":"investigator","description":"Bubblemaps case studies used as leads and corroboration for wallet labels, token launches, and concentration claims.","priority":9,"trust_level":"reliable","primary_sections":["memecoins","markets","culture"],"topic_tags":["onchain investigations","memecoins","rugs","mysteries"],"chain_tags":["ethereum","solana","base"],"project_tags":[],"public_display_name":"Bubblemaps","editorial_title":"Bubblemaps Case Studies","identity_key":"url:https://bubblemaps.io/case-studies/","poll_interval_seconds":3600,"pipeline_role":"both","editorial_fit":5.0},
    {"name":"Rekt News","handle_or_url":"https://www.rekt.news/","platform":"blog","source_type":"blog","primary_class":"investigator","description":"DeFi exploit, hack, and failure reporting with a strong incident and postmortem focus.","priority":9,"trust_level":"reliable","primary_sections":["defi","markets","culture"],"topic_tags":["hacks","exploits","DeFi","postmortems","rugs"],"chain_tags":["ethereum","solana","base"],"project_tags":[],"public_display_name":"Rekt News","editorial_title":"Rekt News","identity_key":"url:https://www.rekt.news/","poll_interval_seconds":1800,"pipeline_role":"discovery","editorial_fit":5.0},
    {"name":"Web3 Is Going Just Great RSS","handle_or_url":"https://web3isgoinggreat.com/feed.xml","platform":"rss","source_type":"rss","primary_class":"investigator","description":"Incident ledger for scams, hacks, NFT failures, and the real-world consequences of Web3 projects.","priority":9,"trust_level":"reliable","primary_sections":["memecoins","markets","culture"],"topic_tags":["rugs","scams","hacks","NFTs","consequences"],"chain_tags":["ethereum","solana","bitcoin"],"project_tags":[],"public_display_name":"Web3 Is Going Just Great","editorial_title":"Web3 Is Going Just Great","identity_key":"url:https://web3isgoinggreat.com/feed.xml","poll_interval_seconds":1800,"pipeline_role":"both","editorial_fit":5.0},
    {"name":"Immunefi Blog RSS","handle_or_url":"https://immunefi.com/blog/rss/","platform":"rss","source_type":"rss","primary_class":"investigator","description":"Bug bounty disclosures, exploit postmortems, and security trends across DeFi protocols.","priority":8,"trust_level":"reliable","primary_sections":["defi","markets","products"],"topic_tags":["hacks","bug bounties","security","DeFi"],"chain_tags":["ethereum","solana","base"],"project_tags":[],"public_display_name":"Immunefi","editorial_title":"Immunefi Blog","identity_key":"url:https://immunefi.com/blog/rss/","poll_interval_seconds":1800,"pipeline_role":"both","editorial_fit":4.0},
    {"name":"SlowMist Medium RSS","handle_or_url":"https://slowmist.medium.com/feed","platform":"rss","source_type":"rss","primary_class":"investigator","description":"Longer blockchain security findings and incident analysis; dedupe against the SlowMist incident database.","priority":8,"trust_level":"reliable","primary_sections":["defi","markets","products"],"topic_tags":["hacks","security","wallets","investigations"],"chain_tags":["ethereum","solana","bitcoin"],"project_tags":[],"public_display_name":"SlowMist","editorial_title":"SlowMist Security","identity_key":"url:https://slowmist.medium.com/feed","poll_interval_seconds":3600,"pipeline_role":"both","editorial_fit":4.0},
    {"name":"SEC Press Releases RSS","handle_or_url":"https://www.sec.gov/news/pressreleases.rss","platform":"rss","source_type":"rss","primary_class":"official","description":"Primary SEC press releases filtered for digital assets, NFTs, exchanges, wallets, stablecoins, and DeFi.","priority":8,"trust_level":"official","primary_sections":["markets","products","culture"],"topic_tags":["regulation","enforcement","NFTs","exchanges","stablecoins"],"chain_tags":["ethereum","bitcoin"],"project_tags":[],"public_display_name":"U.S. Securities and Exchange Commission","editorial_title":"SEC Press Releases","identity_key":"url:https://www.sec.gov/news/pressreleases.rss","poll_interval_seconds":1800,"pipeline_role":"verification","editorial_fit":4.0},
    {"name":"SEC Litigation Releases RSS","handle_or_url":"https://www.sec.gov/enforcement-litigation/litigation-releases/rss","platform":"rss","source_type":"rss","primary_class":"official","description":"Primary SEC litigation releases with named defendants, allegations, settlements, and concrete enforcement facts.","priority":9,"trust_level":"official","primary_sections":["markets","culture","products"],"topic_tags":["enforcement","lawsuits","fraud","regulation","crypto"],"chain_tags":["ethereum","bitcoin"],"project_tags":[],"public_display_name":"U.S. Securities and Exchange Commission","editorial_title":"SEC Litigation Releases","identity_key":"url:https://www.sec.gov/enforcement-litigation/litigation-releases/rss","poll_interval_seconds":1800,"pipeline_role":"both","editorial_fit":4.5},
    {"name":"CFTC Enforcement RSS","handle_or_url":"https://www.cftc.gov/RSS/RSSENF/rssenf.xml","platform":"rss","source_type":"rss","primary_class":"official","description":"Primary CFTC enforcement feed filtered for digital assets, prediction markets, exchanges, fraud, and derivatives.","priority":9,"trust_level":"official","primary_sections":["markets","culture","defi"],"topic_tags":["enforcement","prediction markets","derivatives","fraud","regulation"],"chain_tags":["ethereum","bitcoin"],"project_tags":[],"public_display_name":"Commodity Futures Trading Commission","editorial_title":"CFTC Enforcement","identity_key":"url:https://www.cftc.gov/RSS/RSSENF/rssenf.xml","poll_interval_seconds":1800,"pipeline_role":"both","editorial_fit":4.0},
    {"name":"CFTC General Press Releases RSS","handle_or_url":"https://www.cftc.gov/RSS/RSSGP/rssgp.xml","platform":"rss","source_type":"rss","primary_class":"official","description":"Primary CFTC rulemaking and agency-action feed used when a change has a direct crypto-market consequence.","priority":7,"trust_level":"official","primary_sections":["markets","products","defi"],"topic_tags":["regulation","markets","derivatives","prediction markets"],"chain_tags":["ethereum","bitcoin"],"project_tags":[],"public_display_name":"Commodity Futures Trading Commission","editorial_title":"CFTC Press Releases","identity_key":"url:https://www.cftc.gov/RSS/RSSGP/rssgp.xml","poll_interval_seconds":3600,"pipeline_role":"verification","editorial_fit":3.5},
    {"name":"U.S. DOJ News RSS","handle_or_url":"https://www.justice.gov/news/rss?m=1","platform":"rss","source_type":"rss","primary_class":"official","description":"Primary DOJ news filtered for cryptocurrency, digital assets, NFTs, blockchain, fraud, hacking, and sanctions.","priority":9,"trust_level":"official","primary_sections":["markets","culture","products"],"topic_tags":["fraud","hacks","sanctions","enforcement","crypto"],"chain_tags":["ethereum","bitcoin","solana"],"project_tags":[],"public_display_name":"U.S. Department of Justice","editorial_title":"DOJ News","identity_key":"url:https://www.justice.gov/news/rss?m=1","poll_interval_seconds":1800,"pipeline_role":"both","editorial_fit":4.5},
    {"name":"Coin Center RSS","handle_or_url":"https://www.coincenter.org/feed","platform":"rss","source_type":"rss","primary_class":"publication","description":"Policy interpretation and legal analysis used for discovery, with agency, bill, and court documents as the primary record.","priority":8,"trust_level":"reliable","primary_sections":["markets","products","culture"],"topic_tags":["policy","privacy","regulation","courts"],"chain_tags":["ethereum","bitcoin"],"project_tags":[],"public_display_name":"Coin Center","editorial_title":"Coin Center","identity_key":"url:https://www.coincenter.org/feed","poll_interval_seconds":3600,"pipeline_role":"discovery","editorial_fit":4.0},
    {"name":"a16z crypto RSS","handle_or_url":"https://a16zcrypto.substack.com/feed","platform":"rss","source_type":"rss","primary_class":"publication","description":"Research and commentary on AI agents, identity, payments, consumer products, and crypto policy.","priority":7,"trust_level":"reliable","primary_sections":["products","culture","markets"],"topic_tags":["AI","AI agents","payments","identity","consumer products"],"chain_tags":["ethereum","base"],"project_tags":[],"public_display_name":"a16z crypto","editorial_title":"a16z crypto","identity_key":"url:https://a16zcrypto.substack.com/feed","poll_interval_seconds":7200,"pipeline_role":"discovery","editorial_fit":3.5},
    {"name":"NFTCalendar RSS","handle_or_url":"https://nftcalendar.io/feed","platform":"rss","source_type":"rss","primary_class":"curator","description":"High-noise NFT launch and event feed used for recognizable brands, unusual mechanics, and mainstream crossover only.","priority":7,"trust_level":"useful_signal","primary_sections":["digital-collectibles","culture","products"],"topic_tags":["NFTs","events","launches","brands"],"chain_tags":["ethereum","solana","bitcoin"],"project_tags":[],"public_display_name":"NFTCalendar","editorial_title":"NFTCalendar","identity_key":"url:https://nftcalendar.io/feed","poll_interval_seconds":21600,"pipeline_role":"discovery","editorial_fit":4.5}
  ]
  $sources$::jsonb) as source(
    name text, handle_or_url text, platform text, source_type text, primary_class text,
    description text, priority integer, trust_level text, primary_sections text[],
    topic_tags text[], chain_tags text[], project_tags text[], public_display_name text,
    editorial_title text, identity_key text, poll_interval_seconds integer,
    pipeline_role text, editorial_fit numeric
  )
)
insert into public.source_registry (
  name, handle_or_url, platform, source_type, primary_class, description, active, priority,
  trust_level, direct_publish_eligible, requires_primary_source_lookup, primary_sections,
  topic_tags, chain_tags, project_tags, public_display_name, editorial_title,
  reveal_identity_policy, recurring_character, internal_notes, recurring_formats,
  internal_queue, review_status, identity_key, ingestion_status, poll_interval_seconds,
  pipeline_role, editorial_fit
)
select name, handle_or_url, platform, source_type, primary_class, description, true, priority,
  trust_level, false, true, primary_sections, topic_tags, chain_tags, project_tags,
  public_display_name, editorial_title, 'always', false,
  'Added from the 2026-08-15 Anyways source audit. Use as discovery or verification according to the pipeline role; do not republish feed text.',
  '{}', null, 'ready', identity_key, 'not_activated', coalesce(poll_interval_seconds, 3600),
  pipeline_role, editorial_fit
from candidates
on conflict (identity_key) where identity_key is not null and identity_key <> '' do update
set pipeline_role = excluded.pipeline_role,
    editorial_fit = excluded.editorial_fit,
    priority = excluded.priority,
    poll_interval_seconds = excluded.poll_interval_seconds,
    topic_tags = excluded.topic_tags,
    primary_sections = excluded.primary_sections,
    description = excluded.description,
    updated_at = now();

-- Existing publication feeds from Source Graph V2 are part of the same
-- bounded first tranche. Their feed metadata is useful for latency; article
-- claims still require primary-source verification in the writer.
update public.source_registry
set pipeline_role = case when name = 'The Defiant RSS' then 'discovery' else 'discovery' end,
    editorial_fit = case
      when name in ('CoinDesk RSS', 'Decrypt RSS', 'The Block RSS') then 3.5
      when name = 'Blockworks RSS' then 3.5
      when name = 'Cointelegraph RSS' then 3.0
      when name = 'The Defiant RSS' then 3.0
      else editorial_fit
    end,
    updated_at = now()
where name in ('CoinDesk RSS', 'Decrypt RSS', 'The Block RSS', 'Blockworks RSS', 'Cointelegraph RSS', 'The Defiant RSS');

-- These already-verified X investigators are high-value breaking-news leads
-- when the separate browser collector is healthy. This does not activate X
-- ingestion or change its conservative pacing; it only makes their normalized
-- events eligible for the Hermes proposal queue after collection succeeds.
update public.source_registry
set pipeline_role = 'both',
    editorial_fit = case
      when identity_key = 'x:zachxbt' then 5.0
      when identity_key in ('x:arkhamintel', 'x:lookonchain', 'x:samczsun', 'x:seal_org', 'x:slowmist_team') then 4.5
      when identity_key = 'x:polymarket' then 4.0
      else editorial_fit
    end,
    updated_at = now()
where identity_key in ('x:zachxbt', 'x:arkhamintel', 'x:lookonchain', 'x:samczsun', 'x:seal_org', 'x:slowmist_team', 'x:polymarket')
  and review_status = 'ready';

-- Activate only the bounded, feed-backed first tranche. Pages, paywalled
-- feeds, and sources with known WAF or rate-limit friction remain staged for
-- newsroom validation rather than silently becoming noisy failure loops.
with ready_sources(identity_key) as (
  values
    ('url:https://www.coindesk.com/arc/outboundfeeds/rss/'),
    ('url:https://decrypt.co/feed'),
    ('url:https://www.theblock.co/rss.xml'),
    ('url:https://thedefiant.io/api/feed'),
    ('url:https://blockworks.co/feed'),
    ('url:https://www.dlnews.com/arc/outboundfeeds/rss/category/articles/people-culture/'),
    ('url:https://www.dlnews.com/arc/outboundfeeds/rss/category/articles/web3/'),
    ('url:https://www.dlnews.com/arc/outboundfeeds/rss/category/articles/regulation/'),
    ('url:https://protos.com/feed/'),
    ('url:https://nftnow.com/feed/'),
    ('url:https://nftplazas.com/feed/'),
    ('url:https://dappradar.com/blog/feed'),
    ('url:https://toybook.com/category/product-launches/trading-cards/feed/'),
    ('url:https://www.pokebeach.com/forums/forum/-/index.rss'),
    ('url:https://blog.bubblemaps.io/rss/'),
    ('url:https://web3isgoinggreat.com/feed.xml'),
    ('url:https://immunefi.com/blog/rss/'),
    ('url:https://slowmist.medium.com/feed'),
    ('url:https://www.cftc.gov/RSS/RSSENF/rssenf.xml'),
    ('url:https://www.justice.gov/news/rss?m=1'),
    ('url:https://www.coincenter.org/feed'),
    ('url:https://nftcalendar.io/feed')
)
update public.source_registry as registry
set active = true,
    ingestion_status = 'ready',
    ingestion_blocker = null,
    ingestion_next_eligible_at = now(),
    updated_at = now()
from ready_sources
where registry.identity_key = ready_sources.identity_key
  and registry.review_status = 'ready'
  and registry.source_type in ('rss', 'blog', 'official_announcements');

comment on column public.source_registry.pipeline_role is 'Whether a source discovers story leads, verifies them, does both, or is lead-only.';
comment on column public.source_registry.editorial_fit is 'Anyways editorial fit from the source audit, on a 1.0 to 5.0 scale.';
comment on table public.source_registry is 'Editorial source graph configuration. Source Graph V3 adds high-fit consumer Web3, collectible, incident, policy, and event discovery sources.';

commit;
