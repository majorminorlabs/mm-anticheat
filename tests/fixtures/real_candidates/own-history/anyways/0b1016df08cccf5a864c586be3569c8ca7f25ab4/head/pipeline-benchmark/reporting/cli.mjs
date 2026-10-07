#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregateBenchmarkResults, writeReportingOutputs } from './results.mjs';

const reportingRoot = path.dirname(fileURLToPath(import.meta.url));
const benchmarkRoot = path.resolve(reportingRoot, '..');
const outputDir = path.join(benchmarkRoot, 'results', 'benchmark-v1.0');

const index = await aggregateBenchmarkResults({ benchmarkRoot });
const reports = await writeReportingOutputs({ index, outputDir });
console.log(JSON.stringify({
  benchmark_version: index.benchmark_version,
  benchmark_manifest_hash: index.benchmark_manifest_hash,
  models_indexed: index.models.map(model => model.model_identifier),
  excluded_run_count: index.excluded_runs.length,
  output_dir: outputDir,
  reports
}, null, 2));
