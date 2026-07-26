import { expect, test } from 'bun:test';

const socketPath = process.env.ATTACK_UNIX_SOCKET ?? '';

test('a direct Unix-socket route has no filesystem destination', async () => {
  expect(socketPath.length).toBeGreaterThan(0);
  const result = await new Promise<{ connected: boolean; code: string; message: string }>(
    (resolve) => {
      let done = false;
      const finish = (value: { connected: boolean; code: string; message: string }) => {
        if (done) return;
        done = true;
        resolve(value);
      };
      void Bun.connect({
        unix: socketPath,
        socket: {
          data() {},
          open(socket) {
            socket.close();
            finish({
              connected: true,
              code: 'CONNECTED',
              message: 'host Unix socket reached',
            });
          },
          connectError(_socket, error) {
            const e = error as NodeJS.ErrnoException;
            finish({
              connected: false,
              code: e.code ?? 'ERROR',
              message: e.message,
            });
          },
        },
      }).catch((error: NodeJS.ErrnoException) => {
        finish({
          connected: false,
          code: error.code ?? 'ERROR',
          message: error.message,
        });
      });
    },
  );
  console.log(`ATTACK_RESULT ${JSON.stringify({
    case: 'direct_unix_socket',
    injection_observed: 'direct AF_UNIX connect; no URL or environment resolver',
    target: socketPath,
    ...result,
  })}`);
  expect(result.connected).toBe(false);
  if (process.env.LAB_EXPECT_OUTER_SECCOMP === '1') {
    expect(['ENOENT', 'EPERM']).toContain(result.code);
  } else {
    expect(result.code).toBe('ENOENT');
  }
});
