# Pipeline V1 benchmark drift note

The immutable benchmark validator was run read-only. It failed before generation because the working controller tree differs from the frozen v1.0.3 controller snapshot. No benchmark manifest, frozen packet, score lock, or historical result was modified.

## Hashes

- Expected frozen controller tree hash: `fa6eba3d1ba9c0e80ccdcc5df15f8ca6ab697be22e0449a16b8a57ed07d85110`
- Current controller tree hash: `61fb7f9ef0057e025a04ea8c4efc5d8aa0b6b882b70882c4cfbc15a9220356ef`

## Exact mismatched files

| File | Expected SHA-256 | Current SHA-256 | Classification |
| --- | --- | --- | --- |
| `.env.example` | `fa521bc774c278de95729b1531a0207ad52669b06e972e039a079949419add07` | `7f5275716f16bb9bbff35cb80421ac47ddefefc02f53aedbb5a16d6a9c62b86a` | V1 flag and Phase 2 timeout documentation |
| `src/config.ts` | `4749d3ac7a78d15c0677d40d77123ff8a6a38c131cd0883f63d639e9c77f8fb3` | `eff264f66fbdf8f0c25bc94a529bd1901b2d89085c3339024da125adb9a915d8` | V1 flag and timeout configuration |
| `src/index.ts` | `d8e91e52862ef7b2b5201890b0494f7af09908761eaea04a40e699e67ae51dd7` | `5460fe0bd724f12c12ab4a98fdd0d003e8c9060a89fec8b2035762c6baef3b78` | V1 resource lock routing |
| `src/jobs/types.ts` | `73824930aab37229805dd514ae3a75983fb05f6d078198324ae276e238e8065d` | `91609ee36ef3d3e4645fb71eb8daf1f0f0eabdbe8f441af004ad5c381c137385` | V1 job and authorization validation |
| `src/pipeline/runner.ts` | `f3738324fc831bd71e211545c07d1d6f6aa95a4998c9ac9dbc5ffde8496aa35f` | `91cb99dcd78d03c522fb69a6eb6ff847e555a18467bbceeaae3e61773cac76dc` | V1 arguments and timeout boundary |
| `src/queue/client.ts` | `9ef01dfbb8cbf60ea86b03f438c4326d604b9aa8dc037b1b6e4bd4e590cc9ea2` | `30c10833159dd27fb95dccb122f5fec57983c2a07ee3f87b0a889f1b4399211b` | Named cloud lock support |
| `tests/controller.test.ts` | `0defde68b36b9d981f36567db3c06c6fe205227c053a922a3e7dcd143aed04a9` | `11b22d666bd86c770654c8cae2343fd0c3482083d1565bf808a69b9d5ed45614` | V1 routing regression tests |

Generated counterparts also differ: `dist/src/config.js`, `dist/src/index.js`, `dist/src/jobs/types.js`, `dist/src/pipeline/runner.js`, `dist/src/queue/client.js`, and `dist/tests/controller.test.js`. The new `src/resources/classes.ts` and `dist/src/resources/classes.js` are additional V1 resource-routing files and therefore also change the tree hash.

## Interpretation

The mismatches are explained by the authorized Pipeline V1 controller work. The queue-client change is required because V1 uses the distinct `cloud_codex_generation` lock; the resource-class files are new V1 routing code. The historical validator remains useful as an oracle, but it cannot pass against the intentionally updated production controller tree.

The validator failed before provider execution. Historical benchmark and holdout tests that verify manifests and score locks pass, and no historical benchmark artifact changed.
