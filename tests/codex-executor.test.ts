import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BotConfigBase } from '../src/config.js';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
import { buildCodexArgs, buildCodexEnv, CodexExecutor } from '../src/engines/codex/executor.js';

const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as any;
const config = { name: 'tiger', codex: { model: 'test-model' } } as BotConfigBase;
const opts = () => ({ cwd: '/tmp', prompt: '你好', abortController: new AbortController() });
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
async function collect(handle: ReturnType<CodexExecutor['startExecution']>) {
  const out = [];
  for await (const m of handle.stream) out.push(m);
  return out;
}
afterEach(() => vi.clearAllMocks());

describe('Codex CLI lifecycle', () => {
  it('keeps subscription authentication separate from unrelated API keys', () => {
    const original = {
      OPENAI_API_KEY: 'image-key',
      CODEX_API_KEY: 'other',
      CODEX_ACCESS_TOKEN: 'token',
      OPENAI_BASE_URL: 'proxy',
      PATH: '/bin',
    };
    expect(buildCodexEnv(original)).toEqual({ PATH: '/bin' });
    expect(original.OPENAI_API_KEY).toBe('image-key');
  });
  it('resumes an explicit thread, never the globally last conversation', () => {
    const args = buildCodexArgs({ model: 'bot-model' }, { ...opts(), sessionId: 'thread-id', model: 'override' });
    expect(args).toContain('workspace-write');
    expect(args.slice(args.indexOf('exec'))).toEqual([
      'exec',
      'resume',
      '--json',
      '--skip-git-repo-check',
      'thread-id',
      '-',
    ]);
    expect(args).toContain('override');
    expect(args).not.toContain('--last');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });
  it('parses fragmented UTF-8 and waits for a successful process exit', async () => {
    const proc = child();
    const handle = new CodexExecutor(config, logger).startExecution(opts());
    const pending = collect(handle);
    const encoded = Buffer.from(
      JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: '你好' } }) + '\n',
    );
    const split = encoded.indexOf(Buffer.from('你好')) + 1;
    proc.stdout.write(encoded.subarray(0, split));
    proc.stdout.write(encoded.subarray(split));
    proc.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
    proc.emit('close', 0, null);
    const messages = await pending;
    expect(messages.at(-1)?.result).toBe('你好');
    expect(messages.at(-1)?.is_error).toBe(false);
    expect(messages.filter((m) => m.type === 'result')).toHaveLength(1);
  });
  it('does not declare success when the child fails after a terminal event', async () => {
    const proc = child();
    const handle = new CodexExecutor(config, logger).startExecution(opts());
    const pending = collect(handle);
    proc.stdout.write('{"type":"turn.completed"}\n');
    proc.stderr.write('authentication failed');
    proc.emit('close', 1, null);
    expect((await pending).at(-1)).toMatchObject({
      is_error: true,
      errors: [expect.stringContaining('authentication failed')],
    });
  });
  it('preserves the model capacity error reported by a nonzero child', async () => {
    const proc = child();
    const handle = new CodexExecutor(config, logger).startExecution(opts());
    const pending = collect(handle);
    proc.stdout.write(
      JSON.stringify({
        type: 'turn.failed',
        error: { message: 'Selected model is at capacity. Please try a different model.' },
      }) + '\n',
    );
    proc.emit('close', 1, null);
    expect((await pending).at(-1)?.errors).toEqual(['Selected model is at capacity. Please try a different model.']);
  });

  it('reports a zero-exit child without a result as an error', async () => {
    const proc = child();
    const handle = new CodexExecutor(config, logger).startExecution(opts());
    const pending = collect(handle);
    proc.emit('close', 0, null);
    expect((await pending).at(-1)?.is_error).toBe(true);
  });
  it('reports startup failure exactly once', async () => {
    const proc = child();
    const handle = new CodexExecutor(config, logger).startExecution(opts());
    const pending = collect(handle);
    proc.emit('error', new Error('ENOENT'));
    proc.emit('close', -2, null);
    const messages = await pending;
    expect(messages).toHaveLength(1);
    expect(messages[0].errors).toEqual(['ENOENT']);
  });
  it('marks an aborted turn as cancelled even if the CLI sent success', async () => {
    const proc = child();
    const options = opts();
    const handle = new CodexExecutor(config, logger).startExecution(options);
    const pending = collect(handle);
    proc.stdout.write('{"type":"turn.completed"}\n');
    options.abortController.abort();
    proc.emit('close', 0, null);
    expect((await pending).at(-1)?.subtype).toBe('error_cancelled');
  });
  it('does not spawn for an already aborted request', async () => {
    const options = opts();
    options.abortController.abort();
    const out = await collect(new CodexExecutor(config, logger).startExecution(options));
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(out[0].is_error).toBe(true);
  });
  it('rejects unsupported tool restrictions instead of silently dropping them', async () => {
    const out = await collect(new CodexExecutor(config, logger).startExecution({ ...opts(), allowedTools: [] }));
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(out[0].is_error).toBe(true);
  });
});
