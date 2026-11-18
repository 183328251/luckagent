import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
import { AntigravityAcpClient } from '../src/engines/antigravity/acp-client.js';
const logger = { warn: vi.fn() } as any;
function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: undefined,
  });
  const writes: any[] = [];
  child.stdin.on('data', (chunk) => writes.push(JSON.parse(chunk.toString())));
  mocks.spawn.mockReturnValue(child);
  const client = new AntigravityAcpClient(logger);
  return { child, client, writes };
}
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
describe('Antigravity ACP JSON-RPC transport', () => {
  it('negotiates genuine client identity and keeps prompt requests open while users answer', async () => {
    vi.useFakeTimers();
    const { client, child, writes } = fixture();
    const start = client.start();
    expect(writes[0]).toMatchObject({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientInfo: { name: 'luckagent' },
        clientCapabilities: { elicitation: { form: {} } },
      },
    });
    child.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: writes[0].id,
        result: { protocolVersion: 1, agentInfo: { version: '1.5.10' }, agentCapabilities: { loadSession: true } },
      }) + '\n',
    );
    await start;
    const pending = client.call('session/prompt', { sessionId: 's', prompt: [] });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(120000);
    const last = writes.at(-1);
    expect(last.method).toBe('session/prompt');
    child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: last.id, result: { stopReason: 'end_turn' } }) + '\n');
    await expect(pending).resolves.toEqual({ stopReason: 'end_turn' });
    expect(client.version).toBe('1.5.10');
    await client.close();
  });
  it('handles fragmented UTF-8 requests, emits disconnections and rejects pending work', async () => {
    const { child, client, writes } = fixture();
    const start = client.start();
    child.stdout.write(JSON.stringify({ id: writes[0].id, result: { protocolVersion: 1 } }) + '\n');
    await start;
    const request = vi.fn();
    client.on('request', request);
    const bytes = Buffer.from(
      JSON.stringify({ jsonrpc: '2.0', method: 'elicitation/create', id: 'q', params: { message: '你好' } }) + '\n',
    );
    const split = bytes.indexOf(Buffer.from('你好')) + 1;
    child.stdout.write(bytes.subarray(0, split));
    child.stdout.write(bytes.subarray(split));
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ params: { message: '你好' } }));
    const pending = client.call('session/prompt');
    await vi.waitFor(() => expect(writes.at(-1)?.method).toBe('session/prompt'));
    child.emit('close', 1);
    await expect(pending).rejects.toThrow('exited');
    await client.close();
  });
});
