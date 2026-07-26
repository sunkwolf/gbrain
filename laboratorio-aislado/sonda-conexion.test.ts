import { expect, test } from 'bun:test';
import { createConnection } from 'node:net';

type Attempt = {
  connected: boolean;
  code: string;
  message: string;
};

const caseName = process.env.ATTACK_CASE ?? '';
const expectedTarget = process.env.ATTACK_TARGET ?? '';
const repo = process.env.REPO_ROOT ?? '/workspace';

async function resolveTarget(): Promise<{
  target: string;
  injection: string;
}> {
  if (caseName === 'config_unicode') {
    const { loadConfig } = await import(`${repo}/src/core/config.ts`);
    const target = (loadConfig() as { database_url?: string } | null)?.database_url ?? '';
    return { target, injection: 'JSON.parse(database\\u005furl)' };
  }

  if (caseName === 'database_url') {
    return {
      target: process.env.DATABASE_URL ?? '',
      injection: 'process.env.DATABASE_URL',
    };
  }

  if (caseName === 'gbrain_database_url') {
    const { effectiveEnvDatabaseUrl } = await import(`${repo}/src/core/config.ts`);
    return {
      target: effectiveEnvDatabaseUrl(),
      injection: 'effectiveEnvDatabaseUrl(GBRAIN_DATABASE_URL)',
    };
  }

  if (caseName === 'e2e_allow_db') {
    const { assertSafeE2eDatabaseUrl } =
      await import(`${repo}/test/e2e/helpers.ts`);
    const target = process.env.DATABASE_URL ?? '';
    assertSafeE2eDatabaseUrl(target);
    return {
      target,
      injection: 'assertSafeE2eDatabaseUrl accepted exact opt-in',
    };
  }

  if (caseName === 'dotenv') {
    const { hasDatabase } = await import(`${repo}/test/e2e/helpers.ts`);
    expect(hasDatabase()).toBe(true);
    expect(process.env.DOTENV_EXPORT_MARKER).toBe('loaded');
    return {
      target: process.env.DATABASE_URL ?? '',
      injection: '.env export syntax + .env.testing helper',
    };
  }

  if (caseName === 'path_shim') {
    expect(process.env.PATH_SHIM_MARKER).toBe('loaded');
    return {
      target: process.env.GBRAIN_DATABASE_URL ?? '',
      injection: 'bun shim injected after env -i',
    };
  }

  if (caseName === 'bunfig_preload') {
    expect(process.env.BUNFIG_PRELOAD_MARKER).toBe('loaded');
    return {
      target: process.env.GBRAIN_DATABASE_URL ?? '',
      injection: '[test].preload ran before test',
    };
  }

  if (caseName === 'direct_literal') {
    return {
      target: expectedTarget,
      injection: 'direct socket call; no product resolver',
    };
  }

  throw new Error(`unknown ATTACK_CASE: ${caseName}`);
}

function attemptTcp(target: string): Promise<Attempt> {
  const url = new URL(target);
  const port = Number(url.port);
  return new Promise((resolve) => {
    const socket = createConnection({
      host: url.hostname,
      port,
      timeout: 800,
    });
    let done = false;
    const finish = (result: Attempt) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };
    socket.once('connect', () => {
      finish({ connected: true, code: 'CONNECTED', message: 'host canary reached' });
    });
    socket.once('timeout', () => {
      finish({ connected: false, code: 'TIMEOUT', message: 'no kernel verdict in 800ms' });
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      finish({
        connected: false,
        code: error.code ?? 'ERROR',
        message: error.message,
      });
    });
  });
}

test(`attack is observed, then dies at the absent destination: ${caseName}`, async () => {
  const { target, injection } = await resolveTarget();
  expect(target).toBe(expectedTarget);

  const result = await attemptTcp(target);
  console.log(`ATTACK_RESULT ${JSON.stringify({
    case: caseName,
    injection_observed: injection,
    target,
    ...result,
  })}`);

  expect(result.connected).toBe(false);
  expect(result.code).not.toBe('TIMEOUT');
  const expectedCodes = [
    'ECONNREFUSED',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'EADDRNOTAVAIL',
  ];
  if (process.env.LAB_EXPECT_OUTER_SECCOMP === '1') expectedCodes.push('EPERM');
  expect(expectedCodes).toContain(result.code);
});
