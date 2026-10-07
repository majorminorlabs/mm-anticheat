# Cross-candidate source contamination

## Symptom

The review package for `d77f1cb2880542cea0e2dca093bf39b1e42b5834bd5d67008686fed650e7d3c9` (NASA Science Soars During August Total Solar Eclipse) displayed the unrelated `Smoke Blankets Oregon` document.

## Root cause

Local source IDs were derived only from the host name. Both NASA candidates therefore produced `science_news_article`. Review synchronization selected documents from the global state array by source ID, rather than candidate and processing run. The database additionally enforced global uniqueness on `discovered_documents.normalized_url`, allowing an upsert to reassign document ownership.

## Repair

`20260728143000_pipeline_artifact_ownership.sql` adds explicit pipeline-run ownership to documents, packets, drafts, claims, and images; replaces the global document URL key with a candidate/run key; and rejects claim-source links when their candidate/run differs. `bin/pipeline-sync-supabase.mjs` now synchronizes only the target review's candidate/run records.

The two known NASA packages were re-synchronized idempotently. The eclipse review now retains only its eclipse document. No article text was altered and no story was created or published.

## Future procedure

Run `node bin/pipeline-sync-supabase.mjs <external-candidate-id>` after confirming the local state has a complete review package. It fails with `REVIEW_PACKAGE_INTEGRITY_FAILED` when an artifact, claim, image, or source mapping crosses candidate/run ownership. Do not repair by deleting broad research history.
