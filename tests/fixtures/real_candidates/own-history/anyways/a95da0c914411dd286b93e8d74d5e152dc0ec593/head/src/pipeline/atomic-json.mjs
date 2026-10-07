import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const writeQueues = new Map();

function incidentDirectory(file, configured) {
  return configured || process.env.ANYWAYS_PIPELINE_INCIDENT_DIR || path.resolve(path.dirname(file), '../data/pipeline-v1-activation-20260801/incident');
}

async function preserveMalformedJson(file, bytes, incidentDir) {
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const stamp = new Date().toISOString().replaceAll(/[^0-9]/g, '').slice(0, 14);
  const target = path.join(incidentDirectory(file, incidentDir), `${path.basename(file)}-malformed-${stamp}-${digest.slice(0, 12)}.json`);
  try {
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.copyFile(file, target, fs.constants.COPYFILE_EXCL);
    await fs.chmod(target, 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw Object.assign(new Error(`Could not preserve malformed JSON incident copy: ${error.message}`), { code: 'MALFORMED_JSON_PRESERVATION_FAILED', cause: error });
  }
  return { digest, target };
}

export async function readJsonFile(file, { defaultValue, label = 'JSON file', incidentDir } = {}) {
  let bytes;
  try {
    bytes = await fs.readFile(file);
  } catch (error) {
    if (error.code === 'ENOENT' && defaultValue !== undefined) return defaultValue;
    throw error;
  }
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    const incident = await preserveMalformedJson(file, bytes, incidentDir);
    throw Object.assign(new Error(`${error.message} [${label}; path=${path.resolve(file)}; bytes=${bytes.byteLength}; sha256=${incident.digest}; incident_copy=${incident.target}]`), {
      code: 'MALFORMED_JSON_STATE',
      cause: error,
      path: path.resolve(file),
      bytes: bytes.byteLength,
      sha256: incident.digest,
      incident_copy: incident.target
    });
  }
}

async function writeJsonUnlocked(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    const payload = `${JSON.stringify(value, null, 2)}\n`;
    await fs.writeFile(temporary, payload, { mode: 0o600, flag: 'wx' });
    const handle = await fs.open(temporary, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export function writeJsonFile(file, value) {
  const previous = writeQueues.get(file) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => writeJsonUnlocked(file, value));
  writeQueues.set(file, next);
  return next.finally(() => {
    if (writeQueues.get(file) === next) writeQueues.delete(file);
  });
}
