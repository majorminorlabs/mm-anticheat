import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  BENCHMARK_ROOT,
  REPO_ROOT,
  fileHash,
  readJson,
  relativePosix,
  sha256,
  stableStringify
} from './util.mjs';

const execFileAsync = promisify(execFile);

export const BENCHMARK_VERSION = '1.0';
export const LIFECYCLE_VERSION = '1.0';

export const STAGE_DEPENDENCIES = Object.freeze({
  draft: Object.freeze([]),
  revision: Object.freeze(['draft']),
  reviewer: Object.freeze(['draft']),
  evidence_selector: Object.freeze([]),
  research_planner: Object.freeze([])
});

export const DEFAULT_CONTROLLER_ROOT = '/Volumes/External/GitHub/IGNORED/anyways-controller';
export const FREEZE_MANIFEST_FILE = path.join(BENCHMARK_ROOT, 'config', 'benchmark-v1.0.json');
export const FREEZE_MANIFEST_HASH_FILE = path.join(BENCHMARK_ROOT, 'config', 'benchmark-v1.0.sha256');

export const FROZEN_ARTIFACT_PATHS = Object.freeze({
  prompt_hashes: Object.freeze([
    'prompts/draft.md',
    'prompts/evidence-selector.md',
    'prompts/research-planner.md',
    'prompts/reviewer.md',
    'prompts/revision.md',
    'doctrine/publication.md',
    'doctrine/sections/builders.md',
    'doctrine/sections/internet.md',
    'doctrine/sections/media.md',
    'doctrine/sections/modern-life.md',
    'doctrine/sections/systems.md',
    'doctrine/sections/taste.md',
    'src/prompt-builder.mjs',
    'src/prompt-size.mjs'
  ]),
  schema_hashes: Object.freeze([
    'fixtures/fixture.schema.json',
    'schemas/article-output.schema.json',
    'schemas/evidence-selection.schema.json',
    'schemas/human-score.schema.json',
    'schemas/research-plan.schema.json',
    'schemas/review-output.schema.json',
    'src/schema.mjs'
  ]),
  evaluator_hashes: Object.freeze([
    'src/evaluator.mjs',
    'src/report.mjs'
  ]),
  scoring_doctrine_hashes: Object.freeze([
    'doctrine/scoring.md',
    'schemas/human-score.schema.json',
    'src/blind.mjs'
  ]),
  harness_hashes: Object.freeze([
    'src/cli.mjs',
    'src/fixture.mjs',
    'src/metrics.mjs',
    'src/runner.mjs',
    'src/util.mjs'
  ]),
  validation_hashes: Object.freeze([
    'ops/create-benchmark-freeze.mjs',
    'src/freeze.mjs'
  ])
});

export const LIFECYCLE_ARTIFACT_PATHS = Object.freeze([
  'ops/probe-queue.mjs',
  'ops/smoke-production-model.mjs',
  'src/adapters/kimi-code.mjs',
  'src/adapters/ollama.mjs',
  'src/lifecycle.mjs',
  'src/lock.mjs',
  'src/ollama-transport.mjs',
  'src/production.mjs'
]);

function freezeFailure(changes) {
  const error = new Error([
    `Benchmark v${BENCHMARK_VERSION} freeze validation failed before generation.`,
    ...changes.map(change => `- ${change}`)
  ].join('\n'));
  error.name = 'BenchmarkFreezeError';
  error.code = 'BENCHMARK_FREEZE_MISMATCH';
  error.changes = changes;
  return error;
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function repositoryCommit(repositoryRoot) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repositoryRoot, 'rev-parse', '--verify', 'HEAD'], {
      maxBuffer: 1024 * 1024
    });
    const commit = stdout.trim();
    return /^[a-f0-9]{40}$/.test(commit) ? commit : null;
  } catch {
    return null;
  }
}

export async function repositoryDirty(repositoryRoot) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repositoryRoot, 'status', '--porcelain=v1'], {
      maxBuffer: 4 * 1024 * 1024
    });
    return Boolean(stdout.trim());
  } catch {
    return null;
  }
}

export async function hashRelativeFiles(root, relativeFiles) {
  const hashes = {};
  for (const relative of [...relativeFiles].sort()) {
    hashes[relative] = await fileHash(path.join(root, relative));
  }
  return hashes;
}

function controllerFileAllowed(relative) {
  const parts = relative.split('/');
  if (parts.includes('.git') || parts.includes('node_modules')) return false;
  if (relative === '.env' || relative === 'supabase/.temp' || relative.startsWith('supabase/.temp/')) return false;
  if (relative === '.DS_Store' || relative.endsWith('/.DS_Store')) return false;
  return true;
}

export async function controllerArtifactHashes(controllerRoot = DEFAULT_CONTROLLER_ROOT) {
  const files = [];
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(directory, entry.name);
      const relative = relativePosix(controllerRoot, full);
      if (!controllerFileAllowed(relative)) continue;
      if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile()) {
        files.push(full);
      } else if (entry.isSymbolicLink()) {
        throw new Error(`Symlinks are forbidden in the frozen controller tree: ${full}`);
      }
    }
  }
  await visit(controllerRoot);
  const relativeFiles = files.map(file => relativePosix(controllerRoot, file)).sort();
  return hashRelativeFiles(controllerRoot, relativeFiles);
}

async function approvedFixtureHashes(benchmarkRoot) {
  const fixtureRoot = path.join(benchmarkRoot, 'fixtures');
  const entries = await fs.readdir(fixtureRoot, { withFileTypes: true });
  const fixtures = {};
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const manifestFile = path.join(fixtureRoot, entry.name, 'manifest.json');
    if (!(await fileExists(manifestFile))) continue;
    const manifest = await readJson(manifestFile);
    if (manifest.approval_status !== 'approved') continue;
    fixtures[manifest.fixture_id] = {
      fixture_version: manifest.fixture_version,
      combined_fixture_hash: manifest.combined_fixture_hash
    };
  }
  return fixtures;
}

function compareValue(changes, label, expected, actual) {
  if (stableStringify(expected) !== stableStringify(actual)) {
    changes.push(`${label} changed: expected ${stableStringify(expected)}, found ${stableStringify(actual)}`);
  }
}

async function compareHashMap(changes, label, expected, root) {
  const actual = {};
  for (const relative of Object.keys(expected || {}).sort()) {
    try {
      actual[relative] = await fileHash(path.join(root, relative));
    } catch (error) {
      actual[relative] = `unreadable:${error.code || error.message}`;
    }
  }
  for (const relative of Object.keys(expected || {}).sort()) {
    if (expected[relative] !== actual[relative]) {
      changes.push(`${label}.${relative} changed: expected ${expected[relative]}, found ${actual[relative]}`);
    }
  }
}

export async function commandVersion(executable, args = ['--version']) {
  const { stdout, stderr } = await execFileAsync(executable, args, { maxBuffer: 1024 * 1024 });
  return `${stdout}${stderr}`.trim();
}

export async function validateBenchmarkFreeze({
  manifestFile = FREEZE_MANIFEST_FILE,
  manifestHashFile = FREEZE_MANIFEST_HASH_FILE,
  benchmarkRoot = BENCHMARK_ROOT,
  repoRoot = REPO_ROOT,
  controllerRoot = DEFAULT_CONTROLLER_ROOT,
  expectedBenchmarkVersion = BENCHMARK_VERSION,
  expectedLifecycleVersion = LIFECYCLE_VERSION,
  stageDependencies = STAGE_DEPENDENCIES,
  verifyController = true
} = {}) {
  const changes = [];
  const manifestBytes = await fs.readFile(manifestFile);
  const manifestHash = sha256(manifestBytes);
  const lockedManifestHash = (await fs.readFile(manifestHashFile, 'utf8')).trim().split(/\s+/)[0];
  if (manifestHash !== lockedManifestHash) {
    changes.push(`canonical manifest checksum changed: expected ${lockedManifestHash}, found ${manifestHash}`);
  }

  const manifest = JSON.parse(manifestBytes);
  compareValue(changes, 'benchmark version', expectedBenchmarkVersion, manifest.benchmark_version);
  compareValue(changes, 'fixture hashes', manifest.fixture_hashes, await approvedFixtureHashes(benchmarkRoot));

  for (const group of Object.keys(FROZEN_ARTIFACT_PATHS)) {
    await compareHashMap(changes, group, manifest[group], benchmarkRoot);
  }
  await compareHashMap(changes, 'lifecycle hashes', manifest.lifecycle?.artifact_hashes || {}, benchmarkRoot);

  compareValue(changes, 'lifecycle version', expectedLifecycleVersion, manifest.lifecycle?.version);
  compareValue(changes, 'stage dependency graph', stageDependencies, manifest.stage_dependency_graph);

  const configurationFile = path.join(benchmarkRoot, 'config', 'benchmark.json');
  let configurationHash;
  try {
    configurationHash = await fileHash(configurationFile);
  } catch (error) {
    configurationHash = `unreadable:${error.code || error.message}`;
  }
  if (manifest.benchmark_configuration_hash !== configurationHash) {
    changes.push(`benchmark configuration changed: expected ${manifest.benchmark_configuration_hash}, found ${configurationHash}`);
  }

  try {
    const configuration = await readJson(configurationFile);
    compareValue(changes, 'generation deadline', manifest.generation_deadline_ms, configuration.request_timeout_ms);
  } catch (error) {
    changes.push(`benchmark configuration could not be read: ${error.message}`);
  }

  let currentControllerHashes = null;
  let currentControllerCommit = null;
  if (verifyController) {
    currentControllerHashes = await controllerArtifactHashes(controllerRoot);
    await compareHashMap(
      changes,
      'controller repository artifacts',
      manifest.controller_repository?.artifact_hashes || {},
      controllerRoot
    );
    compareValue(
      changes,
      'controller repository tree hash',
      manifest.controller_repository?.tree_hash,
      sha256(stableStringify(currentControllerHashes))
    );
    currentControllerCommit = await repositoryCommit(controllerRoot);
    compareValue(
      changes,
      'controller repository commit',
      manifest.controller_repository?.commit,
      currentControllerCommit
    );
  }

  if (changes.length) throw freezeFailure(changes);

  return Object.freeze({
    benchmark_version: manifest.benchmark_version,
    benchmark_manifest_hash: manifestHash,
    canonical_manifest: manifest,
    benchmark_repository_commit: await repositoryCommit(repoRoot),
    benchmark_repository_dirty: await repositoryDirty(repoRoot),
    controller_repository_commit: verifyController
      ? currentControllerCommit
      : manifest.controller_repository?.commit ?? null,
    controller_repository_tree_hash: verifyController
      ? sha256(stableStringify(currentControllerHashes))
      : manifest.controller_repository?.tree_hash ?? null
  });
}

export function runBenchmarkMetadata({ validation, modelPlans, executionTimestamp = new Date().toISOString() }) {
  return {
    benchmark_version: validation.benchmark_version,
    benchmark_manifest_hash: validation.benchmark_manifest_hash,
    benchmark_repository_commit: validation.benchmark_repository_commit,
    benchmark_repository_dirty: validation.benchmark_repository_dirty,
    controller_repository_commit: validation.controller_repository_commit,
    controller_repository_tree_hash: validation.controller_repository_tree_hash,
    execution_timestamp: executionTimestamp,
    models: modelPlans.map(model => ({
      model_identifier: model.id,
      provider: model.provider || model.adapter || null,
      model_digest: model.digest || model.expected_digest_prefix || null
    }))
  };
}
