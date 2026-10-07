#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregateV103Results, writeV103Outputs } from './results.mjs';

const cohortRoot = path.dirname(fileURLToPath(import.meta.url));
const benchmarkRoot = path.resolve(cohortRoot, '../../..');
const outputDir = path.join(benchmarkRoot, 'results', 'benchmark-v1.0.3');
const index = await aggregateV103Results({ benchmarkRoot });
const reports = await writeV103Outputs({ index, outputDir });

console.log(JSON.stringify({
  benchmark_version: index.benchmark_version,
  benchmark_manifest_hash: index.benchmark_manifest_hash,
  models_indexed: index.models.map(item => item.model_identifier),
  excluded_run_ids: index.excluded_runs.map(item => item.run_id),
  output_dir: outputDir,
  reports
}, null, 2));
