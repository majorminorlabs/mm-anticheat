# Pipeline V1 controlled smoke test

This is the next operational procedure. It is not executed as part of pre-activation preparation. It must use one approved, low-risk story and must stop before publication.

## Preconditions

- [ ] Diff reviewed and activation-only files selected.
- [ ] Database backup completed.
- [ ] `PIPELINE_V1_ENABLED=false` before migration application.
- [ ] No active job, lease, or resource lock that could be confused with the smoke test.
- [ ] Controller health and queue connectivity are currently passing.
- [ ] The selected pitch is already human-approved and has an explicit `research_requirement` of `none` or `required`.

## Apply and deploy

1. [ ] Apply the five migrations in the documented order:

```sh
cd /Volumes/External/GitHub/IGNORED/anyways
supabase db push --linked
supabase migration list --linked
```

2. [ ] Verify the Phase 2 persistence RPC, V1 commission/research-again RPCs, Sol authorization/persistence/action RPCs, Sol table, and review-decision actions.
3. [ ] Build the controller and verify the artifact:

```sh
cd /Volumes/External/GitHub/IGNORED/anyways-controller
npm run build
test -f /Volumes/External/GitHub/IGNORED/anyways-controller/dist/src/index.js
```

4. [ ] Deploy the reviewed controller bundle using the existing service procedure.
5. [ ] Restart exactly once:

```sh
cd /Volumes/External/GitHub/IGNORED/anyways-controller
npm run launchd -- restart
```

6. [ ] Verify health, queue, leases, and locks:

```sh
curl -fsS http://127.0.0.1:4317/health
cd /Volumes/External/GitHub/IGNORED/anyways-controller
npm run job:list
```

## Scoped one-story run

The scoped activation mechanism requires the V1 job version and exact job-ID match. Keep `PIPELINE_V1_ENABLED=false`, set `PIPELINE_V1_ALLOWED_JOB_ID` to the one queued smoke-test job ID, and clear it after terminalization. The controller and Worker must route only that matching job through V1; all other jobs must remain on the legacy path.

7. [ ] Confirm the ordinary environment reports `PIPELINE_V1_ENABLED=false` and set `PIPELINE_V1_ALLOWED_JOB_ID` only after the smoke-test job ID is known.
8. [ ] Select one approved low-risk candidate and record its external ID without changing the pitch or frozen packet.
9. [ ] Submit exactly one V1 process job through the approved Newsroom/controller path with `pipeline_version: "v1"` and the stored research requirement, then set `PIPELINE_V1_ALLOWED_JOB_ID` to that exact queue job ID before it is claimed.
10. [ ] Verify the job has one attempt and no stale replay.
11. [ ] For `research_requirement: none`, verify zero Terra calls and deterministic packet construction. Insufficient retained evidence must become `research_blocked`.
12. [ ] For `research_requirement: required`, verify exactly one Terra call and valid offset evidence before packet freeze.
13. [ ] Verify exactly one Luna Draft call, no Luna Revision, no automatic Sol call, and no fourth cloud call.
14. [ ] Review the frozen packet checksum, Draft checksum, claim/evidence mappings, deterministic findings, source links, credits, and USD estimate or null.
15. [ ] If desired, authorize exactly one manual `polish_candidate` action and verify Sol’s structured changes, visual diff, unchanged claims/evidence/links/quotes, and recoverable original Draft.
16. [ ] Reject, accept, or restore Sol explicitly and verify actor/timestamp persistence.
17. [ ] Stop at AI Review or On Deck. Do not publish or schedule during the smoke test.

## Cleanup and rollback

18. [ ] Clear `PIPELINE_V1_ALLOWED_JOB_ID` immediately after review; leave `PIPELINE_V1_ENABLED=false`.
19. [ ] Confirm no active V1 job remains and all leases/locks are released.
20. [ ] Submit or inspect one unversioned legacy job only if separately authorized; verify it selects the local-heavy fallback.
21. [ ] If any invariant fails, stop and follow `PIPELINE_V1_ROLLBACK_RUNBOOK.md`.
