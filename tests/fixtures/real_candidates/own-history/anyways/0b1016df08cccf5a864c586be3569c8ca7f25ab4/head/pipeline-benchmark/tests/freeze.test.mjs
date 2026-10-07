import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  BENCHMARK_VERSION,
  LIFECYCLE_VERSION,
  STAGE_DEPENDENCIES,
  validateBenchmarkFreeze
} from '../src/freeze.mjs';
import { BenchmarkLock } from '../src/lock.mjs';
import { BenchmarkRunner } from '../src/runner.mjs';
import { fileHash, sha256, writeFileAtomic, writeJsonAtomic } from '../src/util.mjs';

async function frozenWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anyways-freeze-test-'));
  const benchmarkRoot = path.join(root, 'pipeline-benchmark');
  const controllerRoot = path.join(root, 'controller');
  const generatedRoot = path.join(root, 'generated');
  const files = {
    prompt: 'prompts/draft.md',
    schema: 'schemas/article-output.schema.json',
    evaluator: 'src/evaluator.mjs',
    scoring: 'doctrine/scoring.md',
    lifecycle: 'src/lifecycle.mjs',
    harness: 'src/runner.mjs',
    validation: 'src/freeze.mjs'
  };
  for (const [name, relative] of Object.entries(files)) {
    const file = path.join(benchmarkRoot, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${name}-v1\n`);
  }
  const configurationFile = path.join(benchmarkRoot, 'config', 'benchmark.json');
  await writeJsonAtomic(configurationFile, { request_timeout_ms: 600000 });
  await fs.mkdir(controllerRoot, { recursive: true });
  await fs.writeFile(path.join(controllerRoot, 'runtime.js'), 'controller-v1\n');
  const controllerHashes = {
    'runtime.js': await fileHash(path.join(controllerRoot, 'runtime.js'))
  };
  await writeJsonAtomic(path.join(benchmarkRoot, 'fixtures', 'fixture-a', 'manifest.json'), {
    fixture_id: 'fixture-a',
    fixture_version: '1.0.0',
    approval_status: 'approved',
    combined_fixture_hash: 'a'.repeat(64)
  });

  const hash = relative => fileHash(path.join(benchmarkRoot, relative));
  const manifest = {
    schema_version: '1.0.0',
    benchmark_version: BENCHMARK_VERSION,
    controller_repository: {
      commit: null,
      repository_state: 'unborn',
      tree_hash: sha256(JSON.stringify(controllerHashes)),
      artifact_hashes: controllerHashes
    },
    fixture_hashes: {
      'fixture-a': {
        fixture_version: '1.0.0',
        combined_fixture_hash: 'a'.repeat(64)
      }
    },
    prompt_hashes: { [files.prompt]: await hash(files.prompt) },
    schema_hashes: { [files.schema]: await hash(files.schema) },
    evaluator_hashes: { [files.evaluator]: await hash(files.evaluator) },
    scoring_doctrine_hashes: { [files.scoring]: await hash(files.scoring) },
    harness_hashes: { [files.harness]: await hash(files.harness) },
    validation_hashes: { [files.validation]: await hash(files.validation) },
    lifecycle: {
      version: LIFECYCLE_VERSION,
      artifact_hashes: { [files.lifecycle]: await hash(files.lifecycle) }
    },
    stage_dependency_graph: STAGE_DEPENDENCIES,
    generation_deadline_ms: 600000,
    benchmark_configuration_hash: await fileHash(configurationFile)
  };
  const manifestFile = path.join(benchmarkRoot, 'config', 'benchmark-v1.0.json');
  const manifestHashFile = path.join(benchmarkRoot, 'config', 'benchmark-v1.0.sha256');

  const writeManifest = async () => {
    await writeJsonAtomic(manifestFile, manifest);
    await writeFileAtomic(manifestHashFile, `${await fileHash(manifestFile)}  benchmark-v1.0.json\n`);
  };
  await writeManifest();

  const validationOptions = {
    manifestFile,
    manifestHashFile,
    benchmarkRoot,
    repoRoot: root,
    controllerRoot,
    verifyController: true
  };
  return {
    root,
    benchmarkRoot,
    controllerRoot,
    generatedRoot,
    files,
    manifest,
    writeManifest,
    validationOptions,
    cleanup: () => fs.rm(root, { recursive: true, force: true })
  };
}

const driftCases = [
  {
    name: 'fixture change',
    expected: /fixture hashes changed/,
    mutate: async workspace => {
      const file = path.join(workspace.benchmarkRoot, 'fixtures', 'fixture-a', 'manifest.json');
      const fixture = JSON.parse(await fs.readFile(file, 'utf8'));
      fixture.combined_fixture_hash = 'b'.repeat(64);
      await writeJsonAtomic(file, fixture);
    }
  },
  {
    name: 'prompt change',
    expected: /prompt_hashes\.prompts\/draft\.md changed/,
    mutate: workspace => fs.appendFile(path.join(workspace.benchmarkRoot, workspace.files.prompt), 'changed\n')
  },
  {
    name: 'schema change',
    expected: /schema_hashes\.schemas\/article-output\.schema\.json changed/,
    mutate: workspace => fs.appendFile(path.join(workspace.benchmarkRoot, workspace.files.schema), 'changed\n')
  },
  {
    name: 'evaluator change',
    expected: /evaluator_hashes\.src\/evaluator\.mjs changed/,
    mutate: workspace => fs.appendFile(path.join(workspace.benchmarkRoot, workspace.files.evaluator), 'changed\n')
  },
  {
    name: 'scoring change',
    expected: /scoring_doctrine_hashes\.doctrine\/scoring\.md changed/,
    mutate: workspace => fs.appendFile(path.join(workspace.benchmarkRoot, workspace.files.scoring), 'changed\n')
  },
  {
    name: 'lifecycle change',
    expected: /lifecycle hashes\.src\/lifecycle\.mjs changed/,
    mutate: workspace => fs.appendFile(path.join(workspace.benchmarkRoot, workspace.files.lifecycle), 'changed\n')
  },
  {
    name: 'dependency graph change',
    expected: /stage dependency graph changed/,
    mutate: async workspace => {
      workspace.manifest.stage_dependency_graph = {
        ...structuredClone(STAGE_DEPENDENCIES),
        reviewer: ['revision']
      };
      await workspace.writeManifest();
    }
  },
  {
    name: 'benchmark version change',
    expected: /benchmark version changed/,
    mutate: async workspace => {
      workspace.manifest.benchmark_version = '1.0-modified';
      await workspace.writeManifest();
    }
  },
  {
    name: 'lifecycle version change',
    expected: /lifecycle version changed/,
    mutate: async workspace => {
      workspace.manifest.lifecycle.version = '1.0-modified';
      await workspace.writeManifest();
    }
  },
  {
    name: 'benchmark configuration change',
    expected: /benchmark configuration changed/,
    mutate: async workspace => {
      await writeJsonAtomic(path.join(workspace.benchmarkRoot, 'config', 'benchmark.json'), {
        request_timeout_ms: 600001
      });
    }
  },
  {
    name: 'harness change',
    expected: /harness_hashes\.src\/runner\.mjs changed/,
    mutate: workspace => fs.appendFile(path.join(workspace.benchmarkRoot, workspace.files.harness), 'changed\n')
  },
  {
    name: 'validation engine change',
    expected: /validation_hashes\.src\/freeze\.mjs changed/,
    mutate: workspace => fs.appendFile(path.join(workspace.benchmarkRoot, workspace.files.validation), 'changed\n')
  },
  {
    name: 'controller tree change',
    expected: /controller repository artifacts\.runtime\.js changed/,
    mutate: workspace => fs.appendFile(path.join(workspace.controllerRoot, 'runtime.js'), 'changed\n')
  }
];

for (const drift of driftCases) {
  test(`Benchmark v1.0 aborts before generation on ${drift.name}`, async t => {
    const workspace = await frozenWorkspace();
    t.after(workspace.cleanup);
    await validateBenchmarkFreeze(workspace.validationOptions);
    await drift.mutate(workspace);

    let adapterConstructed = false;
    const runner = new BenchmarkRunner({
      fixtures: [],
      modelPlans: [],
      adapterFactory: () => {
        adapterConstructed = true;
        throw new Error('Adapter must not be constructed after freeze drift.');
      },
      lock: new BenchmarkLock(path.join(workspace.root, 'lock')),
      generatedRoot: workspace.generatedRoot,
      configuration: {},
      freezeValidator: () => validateBenchmarkFreeze(workspace.validationOptions)
    });

    await assert.rejects(
      () => runner.run(),
      error => {
        assert.equal(error.code, 'BENCHMARK_FREEZE_MISMATCH');
        assert.match(error.message, drift.expected);
        return true;
      }
    );
    assert.equal(adapterConstructed, false);
    await assert.rejects(() => fs.access(workspace.generatedRoot));
  });
}

test('Benchmark v1.0 manifest checksum is itself locked', async t => {
  const workspace = await frozenWorkspace();
  t.after(workspace.cleanup);
  const original = JSON.parse(await fs.readFile(workspace.validationOptions.manifestFile, 'utf8'));
  original.benchmark_version = '1.0-modified';
  await writeJsonAtomic(workspace.validationOptions.manifestFile, original);
  await assert.rejects(
    () => validateBenchmarkFreeze(workspace.validationOptions),
    error => error.code === 'BENCHMARK_FREEZE_MISMATCH'
      && /canonical manifest checksum changed/.test(error.message)
  );
});

test('run metadata contains frozen identity and model data without affecting the manifest hash', async () => {
  const workspace = await frozenWorkspace();
  try {
    const validation = await validateBenchmarkFreeze(workspace.validationOptions);
    assert.equal(validation.benchmark_version, '1.0');
    assert.match(validation.benchmark_manifest_hash, /^[a-f0-9]{64}$/);
    assert.equal(
      validation.benchmark_manifest_hash,
      sha256(await fs.readFile(workspace.validationOptions.manifestFile))
    );
  } finally {
    await workspace.cleanup();
  }
});
