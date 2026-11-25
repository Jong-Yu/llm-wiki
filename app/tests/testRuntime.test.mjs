import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { waitForReady, stopProcess } from './testRuntime.mjs';

function fixture() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  return child;
}

function assertDetached(child) {
  assert.equal(child.stdout.listenerCount('data'), 0);
  assert.equal(child.listenerCount('error'), 0);
  assert.equal(child.listenerCount('close'), 0);
}

test('READY marker and port may cross any stdout chunk boundary', async () => {
  const line = 'READY http://127.0.0.1:12345\r\n';
  for (let split = 1; split < line.length; split += 1) {
    const child = fixture();
    let resolved = false;
    const ready = waitForReady(child).then((url) => {
      resolved = true;
      return url;
    });
    child.stdout.emit('data', Buffer.from(line.slice(0, split)));
    await Promise.resolve();
    assert.equal(resolved, false, `must wait for complete line at ${split}`);
    child.stdout.emit('data', Buffer.from(line.slice(split)));
    assert.equal(await ready, 'http://127.0.0.1:12345');
    assertDetached(child);
  }
});

test('ignores noise, oversized lines and malformed READY lines', async () => {
  const child = fixture();
  const ready = waitForReady(child);
  child.stdout.emit('data', Buffer.from('x'.repeat(70000)));
  child.stdout.emit(
    'data',
    Buffer.from('READY http://127.0.0.1:1\nREADY https://example.com\n'),
  );
  child.stdout.emit('data', Buffer.from('log\nREADY http://127.0.0.1:23456\n'));
  assert.equal(await ready, 'http://127.0.0.1:23456');
  assertDetached(child);
});

test('startup failures and timeout release listeners', async () => {
  for (const event of ['error', 'close', 'timeout']) {
    const child = fixture();
    const ready = waitForReady(child, {
      timeoutMs: 10,
      timeoutMessage: () => 'fixture timed out',
      stoppedMessage: () => 'fixture stopped',
    });
    const rejection = assert.rejects(ready, /fixture/);
    if (event !== 'timeout')
      child.emit(event, new Error('fixture spawn failed'));
    await rejection;
    assertDetached(child);
  }
});

test('real spawn failure rejects and cleanup does not hang', async () => {
  const child = spawn('/nonexistent/wiki-fixture-server', [], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await assert.rejects(waitForReady(child), { code: 'ENOENT' });
  await stopProcess(child);
});

test('cleanup stops a ready server and tolerates a second cleanup', async () => {
  const child = spawn(
    process.execPath,
    [
      '-e',
      "console.log('READY http://127.0.0.1:12345'); setInterval(() => {}, 1000)",
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  await waitForReady(child);
  await stopProcess(child);
  assert.equal(child.signalCode, 'SIGTERM');
  await stopProcess(child);
});
