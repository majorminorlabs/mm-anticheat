# Anyways architecture

The first working version uses a durable JSON data store at `data/anyways.json`, which is created by the seed command. It has normalized collections for users, sections, topics, stories, sources, revisions, media, homepage placement, and search logs. Story topic and related-story fields hold IDs, not comma-separated content.

Private newsroom sessions use an HTTP-only session cookie. Server-side checks enforce admin, editor, and contributor permissions. The workflow is enforced on save; publication also validates all required editorial fields and a valid structured source.

Public routes cover the homepage, search, topics, sections, authors, and stable story slugs. Search is an in-process full-text implementation over the stored editorial fields; the module boundary can be replaced with a database search provider later. The scheduler executes on every request and is idempotent: a due scheduled story is published only once after validation. In production, invoke the application or a small cron request regularly.

Media records include the publication URL, alt text, caption, and credit. The first pass supports a URL-backed library; replacing it with object storage upload does not change story data. `rss.xml`, per-section RSS, sitemap, and robots routes are included.
