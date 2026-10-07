#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregateV102Results, writeV102Outputs } from './results.mjs';

const cohortRoot = path.dirname(fileURLToPath(import.meta.url));
const benchmarkRoot = path.resolve(cohortRoot, '../../..');
const outputDir = path.join(benchmarkRoot, 'results', 'benchmark-v1.0.2');
const index = await aggregateV102Results({ benchmarkRoot });
const reports = await writeV102Outputs({ index, outputDir });

console.log(JSON.stringify({
  benchmark_version: index.benchmark_version,
  benchmark_manifest_hash: index.benchmark_manifest_hash,
  models_indexed: index.models.map(item => item.model_identifier),
  excluded_run_ids: index.excluded_runs.map(item => item.run_id),
  output_dir: outputDir,
  reports
}, null, 2));
