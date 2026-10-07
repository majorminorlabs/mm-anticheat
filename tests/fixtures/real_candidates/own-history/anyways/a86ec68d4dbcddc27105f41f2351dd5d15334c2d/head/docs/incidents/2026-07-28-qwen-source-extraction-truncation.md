# Qwen source-extraction truncation

## Symptom

Two local runs failed during source extraction after Qwen emitted a long `support` field copied from page boilerplate. The response reached the configured 800-token cap before the JSON object closed.

## Cause

The prior stage sent up to 5,000 extracted characters into an 8,192-token context, allowed unbounded source-support strings, and used a two-attempt generic repair path. The Ollama adapter already used JSON Schema `format`, `think:false`, `num_ctx:8192`, and `num_predict`; the failure was output budget/schema scope, not a browser, queue, or ownership failure.

## Reliability changes

Extraction is one document per call with a compact schema: relevance, bounded retention reason, and at most four concise source-grounded facts. Source text is cleaned and capped at 2,800 characters, then reduced to 1,500 for recovery. The response budget is 520 tokens, then 420 with reduced schema complexity. The parser accepts a complete JSON object surrounded by harmless text or a JSON fence, but never incomplete JSON.

Three adaptive attempts are recorded with source ID, input character/token estimate, output size, truncation flag, strategy, and validation errors. Successful document extraction files remain in the candidate/run artifact directory and are reused only for the same immutable fingerprint. Final codes are `SOURCE_EXTRACTION_TRUNCATED` and `SOURCE_EXTRACTION_INVALID_JSON`.

## Operational check

Inspect `pipeline-artifacts/<candidate-run>/source-extraction.*.attempt-*.json`. Do not replay malformed output. Retry with the stored candidate/run context; successful documents stay isolated and only the failed source is rerun.

## Live validation, 2026-07-28

Two post-fix Newsroom submissions reached `ready_for_review` through the durable queue, local controller, Qwen extraction, pipeline, and Supabase review synchronization:

- `NASA to Cover Three US Spacewalks, Host Preview News Conference` (`2ee955afc4bb19744605f6a64d757d494bd6da25966df92e2d8ba59efe530cc8`): job `6a7ecf32-352c-47a4-9ff0-d0dbf2de54c3`, run `5180c494-eaea-4a15-ba4f-f64af06e03df`, review `9456a576-48e5-44e0-985b-a556ab722847`.
- `NASA Astronaut Chris Williams to Discuss Space Station Mission` (`32b0ce89958dc3e3c7392e11418cc059e31eab4698e89c6aa95f931824f29a5c`): job `264d8aaf-5551-45a0-af17-d8fa88e159b5`, run `9d6d7312-473d-4119-a64d-4ea4c53b8603`, review `ddc33890-63e7-4d36-aef6-b80500039e96`.

Each successful source completed one `normal_bounded` extraction attempt with a 520-token response cap, no truncation, and no schema or parser errors. The two synchronized packages each retained one candidate-owned source, one image, a candidate/run-owned research packet, two drafts, and claim-source links only to their own retained document. No story link was created.

The attempted replacement validation did not complete. `NASA’s Hubble Shows Star Formation in Andromeda Galaxy Winding Down` first ran as `5323d028-1ef5-48cd-b064-e187e885995b` (job `65fdb6fb-5e46-4a18-908c-c28739859bb0`) and received two further Newsroom-submitted replacements: `006c41f6-a592-47bc-a043-426b6c998e9d` (job `764cc668-1479-45e1-b865-24d2851ca4e8`) and `fb73aea7-5e66-4770-a8a0-e5178b8b9fdc` (job `6c11f7b8-cd84-41af-8559-29dae2e1ce91`). All three source-extraction attempts succeeded, but every replacement failed closed at the later `slop` stage after its bounded JSON output was exhausted. This is separate from source extraction and was not weakened or changed during validation.

Qwen `qwen3:14b` was loaded only while jobs ran. After the final job, the controller health endpoint remained healthy with no active job and Ollama `api/ps` returned an empty model list. The permanent ten-minute idle-unload policy was not changed.

## Final slop-stage resolution

The failure was not source extraction. The old style stage sent the full accumulated context and requested a complete rewrite plus unbounded passage diagnostics in one 1,800-token JSON response. The replacement stage sends only the draft and compact proofreading context, returns one `revised_body` plus at most three short changes and warnings, uses `think: false`, and applies 1,250, 1,050, then 950-token recovery budgets. Local validation enforces string, array, and 700-word body bounds; the Ollama format adapter removes unsupported `maxLength` grammar terms while retaining structural JSON Schema enforcement.

Candidate C completed through the corrected path: Newsroom job `e6614596-9c44-4ae0-a181-2ffd8f2b60bb`, isolated processing run `99ead68c-fdac-4494-b64a-f226a3baff70`, review `9a4987cb-8ef2-4692-9a7d-a24324c8e766`, status `ready_for_review`. No story was created or published.
