import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BotConfigBase } from '../src/config.js';
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
import { AntigravityExecutor, buildAntigravityArgs } from '../src/engines/antigravity/executor.js';
const logger = { warn: vi.fn() } as any;
const config = { name: 'test', antigravity: { model: 'test-model' } } as BotConfigBase;
const options = () => ({ cwd: '/tmp', prompt: '-你好 /model', abortController: new AbortController() });
function child() {
  const proc = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: undefined,
  });
  mocks.spawn.mockReturnValue(proc);
  return proc;
}
async function collect(handle: ReturnType<AntigravityExecutor['startExecution']>) {
  const messages = [];
  for await (const m of handle.stream) messages.push(m);
  return messages;
}
afterEach(() => vi.clearAllMocks());
describe('Antigravity subprocess adapter', () => {
  it('uses explicit conversation IDs, structured stdin and a sandbox', () => {
    const args = buildAntigravityArgs(
      { model: 'default', reasoningEffort: 'high' },
      { ...options(), sessionId: 'conversation-1', model: 'override' },
    );
    expect(args).toContain('--sandbox');
    expect(args).toContain('--disable-slash-commands');
    expect(args).toContain('--conversation');
    expect(args).toContain('conversation-1');
    expect(args).toContain('override');
    expect(args).not.toContain('--continue');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).not.toContain(options().prompt);
    expect(buildAntigravityArgs({ skipPermissions: true }, options())).toContain('--dangerously-skip-permissions');
  });
  it('handles UTF-8 fragmentation and flushes a final line without a newline', async () => {
    const proc = child();
    const handle = new AntigravityExecutor(config, logger).startExecution(options());
    const pending = collect(handle);
    proc.stdout.write('{"event":"init","conversation_id":"new-session"}\n');
    const bytes = Buffer.from(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '你好' } }));
    const split = bytes.indexOf(Buffer.from('你好')) + 1;
    proc.stdout.write(bytes.subarray(0, split));
    proc.stdout.write(bytes.subarray(split));
    proc.emit('close', 0);
    const messages = await pending;
    expect(messages.at(-1)).toMatchObject({ result: '你好', is_error: false, session_id: 'new-session' });
    expect(messages.filter((m) => m.type === 'result')).toHaveLength(1);
    const input = JSON.parse(proc.stdin.read().toString());
    expect(input.message.content).toContain(options().prompt);
  });
  it('reports spawn failures and does not report success after an abnormal exit', async () => {
    let proc = child();
    let pending = collect(new AntigravityExecutor(config, logger).startExecution(options()));
    proc.emit('error', new Error('ENOENT'));
    expect((await pending).at(-1)?.errors).toEqual(['ENOENT']);
    proc = child();
    pending = collect(new AntigravityExecutor(config, logger).startExecution(options()));
    proc.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"ok"}}\n');
    proc.stderr.write('authentication required');
    proc.emit('close', 2);
    expect((await pending).at(-1)).toMatchObject({
      is_error: true,
      errors: [expect.stringContaining('authentication required')],
    });
  });
  it('cancels cleanly and rejects unsupported restrictions before starting a process', async () => {
    const opts = options();
    opts.abortController.abort();
    expect((await collect(new AntigravityExecutor(config, logger).startExecution(opts))).at(-1)?.subtype).toBe(
      'error_cancelled',
    );
    expect(
      (await collect(new AntigravityExecutor(config, logger).startExecution({ ...options(), allowedTools: [] }))).at(-1)
        ?.is_error,
    ).toBe(true);
    expect(mocks.spawn).not.toHaveBeenCalled();
    const proc = child();
    const running = options();
    const pending = collect(new AntigravityExecutor(config, logger).startExecution(running));
    running.abortController.abort();
    proc.emit('close', null, 'SIGTERM');
    expect((await pending).at(-1)?.subtype).toBe('error_cancelled');
  });
});
