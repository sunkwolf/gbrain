/**
 * F2 measurement patch (2/2f) — the FILE plane of the config read.
 *
 * The ninth audit's open blocker. `loadConfig` wrapped read + `JSON.parse` +
 * `migrateLegacyEmbeddingConfig` in ONE empty catch, so these two states were
 * byte-identical from outside:
 *
 *   there is no config file        → honest, and the normal install state
 *   the file is there and broken   → the embedding model, dimensions and column
 *                                    registry were silently lost
 *
 * The second one is the dangerous one, and it is invisible in the worst possible
 * way: `loadConfigWithEngine` then synthesizes `{engine:'postgres'}`, the
 * DB-plane diagnostic keeps saying `ok` (nothing failed on ITS side), and the run
 * searches a different vector space than the operator configured with every
 * instrument green. That is the exact failure class this whole patch exists to
 * kill, sitting inside the instrument built to detect it.
 *
 * Serial: mutates process.env.GBRAIN_HOME (isolation guard R2).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadConfig,
  loadConfigWithEngine,
  fileConfigReadFailures,
  type ConfigReadDiag,
  type FileConfigReadDiag,
} from '../src/core/config.ts';

const savedHome = process.env.GBRAIN_HOME;
const savedDbUrl = process.env.DATABASE_URL;
const savedGbrainDbUrl = process.env.GBRAIN_DATABASE_URL;
let home: string;
let cfgDir: string;
let cfgFile: string;
const created: string[] = [];

function diag(): FileConfigReadDiag {
  return { outcome: 'not_read' };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-fileplane-'));
  created.push(home);
  process.env.GBRAIN_HOME = home;
  cfgDir = join(home, '.gbrain');
  cfgFile = join(cfgDir, 'config.json');
  mkdirSync(cfgDir, { recursive: true });
  // An env DB URL would make `loadConfig` return a config even with no file,
  // which is a different scenario than the one under test.
  delete process.env.DATABASE_URL;
  delete process.env.GBRAIN_DATABASE_URL;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = savedHome;
  if (savedDbUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDbUrl;
  if (savedGbrainDbUrl === undefined) delete process.env.GBRAIN_DATABASE_URL;
  else process.env.GBRAIN_DATABASE_URL = savedGbrainDbUrl;
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('loadConfig file-plane diagnostic', () => {
  test('a healthy file reports ok', () => {
    writeFileSync(cfgFile, JSON.stringify({ engine: 'postgres', embedding_dimensions: 1536 }));
    const d = diag();
    const cfg = loadConfig(d);
    expect(cfg).not.toBeNull();
    expect(d.outcome).toBe('ok');
    expect(fileConfigReadFailures(d)).toEqual([]);
  });

  test('NO config file is `absent` — honest, and NOT a failure', () => {
    // This is the distinction the single catch destroyed, and getting it wrong in
    // the other direction is just as bad: a clean install with no config file is
    // the majority case, so calling it a fallback would make the signal fire
    // everywhere until nobody reads it.
    const d = diag();
    expect(loadConfig(d)).toBeNull();
    expect(d.outcome).toBe('absent');
    expect(d.error).toBeUndefined();
    expect(fileConfigReadFailures(d)).toEqual([]);
  });

  test('🔴 malformed JSON is `parse_error` — a FAILURE, and no longer looks absent', () => {
    writeFileSync(cfgFile, '{ "engine": "postgres", ');
    const d = diag();
    // Behavior is unchanged: a broken file still yields null, exactly as before.
    expect(loadConfig(d)).toBeNull();
    // What changed is that it is now DISTINGUISHABLE from having no file at all.
    expect(d.outcome).toBe('parse_error');
    expect(d.error).toBeTruthy();
    expect(fileConfigReadFailures(d)).toEqual([
      expect.stringContaining('config_file (parse_error'),
    ]);
  });

  test('🔴 a file that cannot be read is `unreadable`, not `absent`', () => {
    // A directory where the config file should be: exists, cannot be read.
    // EACCES would be the other common cause, but a permission-based test is
    // unreliable under root (CI containers), and the code path is the same — the
    // outcome is decided by "is the errno ENOENT", nothing else.
    rmSync(cfgFile, { force: true });
    mkdirSync(cfgFile);
    const d = diag();
    expect(loadConfig(d)).toBeNull();
    expect(d.outcome).toBe('unreadable');
    expect(d.error).toBeTruthy();
    expect(fileConfigReadFailures(d)).toEqual([
      expect.stringContaining('config_file (unreadable'),
    ]);
  });

  test('the four keys a broken file hides are exactly the ones that pick the vector space', () => {
    // Not a behavior assertion — a statement of the stakes, pinned so a future
    // reader cannot mistake this diagnostic for cosmetics. With the file broken,
    // every one of these reverts to a default while the DB plane reports `ok`.
    writeFileSync(
      cfgFile,
      JSON.stringify({
        engine: 'postgres',
        embedding_model: 'voyage:voyage-3-large',
        embedding_dimensions: 1024,
        embedding_columns: { embedding_voyage: { type: 'vector', dimensions: 1024, provider: 'voyage' } },
        search_embedding_column: 'embedding_voyage',
      }),
    );
    const healthy = loadConfig();
    expect(healthy?.embedding_model).toBe('voyage:voyage-3-large');
    expect(healthy?.embedding_dimensions).toBe(1024);
    expect(healthy?.search_embedding_column).toBe('embedding_voyage');

    writeFileSync(cfgFile, 'not json at all');
    const d = diag();
    const broken = loadConfig(d);
    expect(d.outcome).toBe('parse_error');
    expect(broken).toBeNull(); // all four gone, silently, before this patch
  });
});

describe('loadConfigWithEngine threads the file plane', () => {
  const engine = {
    async getConfig() {
      return undefined;
    },
    async listConfigKeys() {
      return [] as string[];
    },
  };

  test('the DB-plane diag carries the file-plane outcome', async () => {
    writeFileSync(cfgFile, '{ broken');
    const d: ConfigReadDiag = { readErrors: [] };
    const cfg = await loadConfigWithEngine(engine, undefined, d);
    // The synthesized base is why this was invisible: the loader returns a
    // perfectly usable config, so no null check anywhere can see the failure.
    expect(cfg).not.toBeNull();
    expect(cfg?.engine).toBe('postgres');
    // The DB plane itself did not fail, and must not claim it did.
    expect(d.readErrors).toEqual([]);
    // The file plane did, and now says so.
    expect(d.filePlane?.outcome).toBe('parse_error');
  });

  test('an explicit base means NO file read, and `not_read` says so', async () => {
    // `not_read` is not `ok`. A receipt that reported 'ok' here would be
    // claiming a successful read that never happened.
    writeFileSync(cfgFile, '{ broken');
    const d: ConfigReadDiag = { readErrors: [] };
    await loadConfigWithEngine(engine, { engine: 'pglite' }, d);
    expect(d.filePlane?.outcome).toBe('not_read');
    expect(fileConfigReadFailures(d.filePlane)).toEqual([]);
  });

  test('🔴 an unusable DB boolean is diagnosed, and the VALUE still resolves as before', async () => {
    // `v === 'true'` read any other string as a confident false with no trace:
    // "TRUE", "1", "yes", a truncated write. The patch may not change what the
    // engine does — so the resolved value stays false — but silence about an
    // unusable value contradicts what this instrument promises.
    const garbage = {
      async getConfig(key: string) {
        return key === 'embedding_multimodal' ? 'TRUE' : undefined;
      },
      async listConfigKeys() {
        return [] as string[];
      },
    };
    const d: ConfigReadDiag = { readErrors: [] };
    const cfg = await loadConfigWithEngine(garbage, { engine: 'pglite' }, d);
    expect(cfg?.embedding_multimodal).toBe(false); // behavior preserved
    expect(d.readErrors).toEqual([
      expect.stringContaining('embedding_multimodal (invalid boolean'),
    ]);
  });

  test('a valid `false` is NOT flagged — the control that keeps the flag meaningful', () => {
    // Without this, an implementation that flagged every falsy value would pass
    // the test above while making the diagnostic fire on correct config.
    const valid = {
      async getConfig(key: string) {
        return key === 'embedding_multimodal' ? 'false' : undefined;
      },
      async listConfigKeys() {
        return [] as string[];
      },
    };
    const d: ConfigReadDiag = { readErrors: [] };
    return loadConfigWithEngine(valid, { engine: 'pglite' }, d).then((cfg) => {
      expect(cfg?.embedding_multimodal).toBe(false);
      expect(d.readErrors).toEqual([]);
    });
  });
});
