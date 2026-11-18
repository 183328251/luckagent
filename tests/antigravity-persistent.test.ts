import { StreamProcessor } from '../src/engines/claude/stream-processor.js';
import { buildCardV2 } from '../src/feishu/card-builder-v2.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { PersistentAntigravityExecutor } from '../src/engines/antigravity/persistent-executor.js';
import { MessageBridge } from '../src/bridge/message-bridge.js';
import { formAnswer, formQuestions } from '../src/engines/antigravity/questions.js';
const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return this;
  },
} as any;
const form = {
  mode: 'form',
  message: 'Choose a color',
  requestedSchema: {
    type: 'object',
    properties: {
      q1: {
        type: 'string',
        title: 'Color?',
        oneOf: [
          { const: '1', title: 'blue' },
          { const: '2', title: 'green' },
        ],
      },
      q1_other: { type: 'string', title: 'Other' },
    },
  },
};
class Client extends EventEmitter {
  capabilities = { sessionCapabilities: { resume: {}, close: {}, additionalDirectories: {} } };
  calls: Array<{ method: string; params: any }> = [];
  prompts = new Map<string, (result: any) => void>();
  respond = vi.fn();
  reject = vi.fn();
  close = vi.fn(async () => {});
  async start() {}
  async call(method: string, params: any) {
    this.calls.push({ method, params });
    if (method === 'session/new' || method === 'session/resume')
      return {
        sessionId: params.sessionId || `session-${this.calls.length}`,
        models: { currentModelId: 'model-default' },
        configOptions: [
          { id: 'model', category: 'model', options: [{ value: 'gemini' }] },
          { id: 'thought_level', category: 'thought_level', options: [{ value: 'high' }] },
        ],
      };
    if (method === 'session/prompt') return new Promise((resolve) => this.prompts.set(params.sessionId, resolve));
    if (method === 'session/close') this.done(params.sessionId, 'cancelled');
    return {};
  }
  notify(method: string, params: any) {
    this.calls.push({ method, params });
    if (method === 'session/cancel') this.done(params.sessionId, 'cancelled');
  }
  update(sessionId: string, update: any) {
    this.emit('notification', { method: 'session/update', params: { sessionId, update } });
  }
  done(sessionId: string, stopReason = 'end_turn') {
    this.prompts.get(sessionId)?.({ stopReason });
    this.prompts.delete(sessionId);
  }
}
let root: string;
let client: Client;
let runtime: PersistentAntigravityExecutor;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const config = () =>
  ({
    name: 'test',
    engine: 'antigravity',
    antigravity: {},
    claude: {
      defaultWorkingDirectory: root,
      outputsBaseDir: path.join(root, 'outputs'),
      downloadsDir: root,
      maxTurns: undefined,
      maxBudgetUsd: undefined,
    },
  }) as any;
const options = (sessionId?: string) => ({
  cwd: root,
  prompt: 'hello',
  sessionId,
  abortController: new AbortController(),
  apiContext: { botName: 'test', chatId: 'chat' },
});
async function collect(handle: any) {
  const out = [];
  for await (const message of handle.stream) out.push(message);
  return out;
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-persistent-'));
  vi.stubEnv('SESSION_STORE_DIR', root);
  client = new Client();
  runtime = new PersistentAntigravityExecutor(config(), logger, client as any);
});
afterEach(async () => {
  await runtime.shutdown();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});
describe('Antigravity ACP runtime', () => {
  it('renders native model/context metadata live and after compaction without cumulative-token guesses', async () => {
    client.update('s', { sessionUpdate: 'usage_update', used: 12000, size: 1000000 });
    const processor = new StreamProcessor('test');
    const states: any[] = [];
    const pending = (async () => {
      for await (const message of runtime.startExecution(options('s')).stream)
        states.push(processor.processMessage(message));
    })();
    await tick();
    expect(states.at(-1)).toMatchObject({ model: 'model-default', totalTokens: 12000, contextWindow: 1000000 });
    client.update('s', { sessionUpdate: 'usage_update', used: 25000, size: 1000000 });
    await tick();
    expect(states.at(-1).totalTokens).toBe(25000);
    client.update('s', { sessionUpdate: 'usage_update', used: null, size: 1000000 });
    client.update('s', { sessionUpdate: 'usage_update', used: -1, size: 1000000 });
    client.update('s', { sessionUpdate: 'usage_update', used: 5000, size: 1000000 });
    client.update('s', {
      sessionUpdate: 'config_option_update',
      configOptions: [{ category: 'model', currentValue: 'gemini-live' }],
    });
    client.done('s');
    await pending;
    const state = states.at(-1);
    expect(state).toMatchObject({ model: 'gemini-live', totalTokens: 5000, contextWindow: 1000000 });
    const card = buildCardV2(state);
    expect(card).toContain('gemini-live');
    expect(card).toContain('ctx: 5.0k/1000k (1%)');
    const result = await collect(runtime.startExecution({ ...options(), allowedTools: [] }));
    expect(result.at(-1)?.engineStats).toBeUndefined();
  });
  it('shows the native default model even when the CLI provides no context occupancy', async () => {
    const pending = collect(runtime.startExecution(options('s')));
    await tick();
    client.done('s');
    const messages = await pending;
    const state = new StreamProcessor('test').processMessage(messages.at(-1)!);
    expect(state.model).toBe('model-default');
    expect(state.totalTokens).toBeUndefined();
    expect(buildCardV2(state)).not.toContain('ctx:');
  });

  it('keeps a warm session and resumes native IDs after restart', async () => {
    const first = collect(runtime.startExecution(options()));
    await tick();
    const id = [...client.prompts.keys()][0];
    client.update(id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } });
    client.done(id);
    expect((await first).at(-1)).toMatchObject({ result: 'hello', is_error: false, session_id: id });
    const second = collect(runtime.startExecution(options(id)));
    await tick();
    client.done(id);
    await second;
    expect(client.calls.filter((c) => c.method === 'session/new')).toHaveLength(1);
    const resumed = collect(runtime.startExecution(options('saved-id')));
    await tick();
    client.done('saved-id');
    await resumed;
    expect(client.calls.find((c) => c.method === 'session/resume')?.params.sessionId).toBe('saved-id');
    expect(client.close).not.toHaveBeenCalled();
  });
  it('maps native choice forms, optional free text, permission denial and cancellation', async () => {
    expect(formQuestions(form)).toHaveLength(1);
    expect(formQuestions(form)[0].options).toEqual([{ label: 'blue' }, { label: 'green' }]);
    expect(formAnswer(form, { 'Color?': 'blue' })).toEqual({ q1: '1' });
    expect(formAnswer(form, { 'Color?': 'purple' })).toEqual({ q1_other: 'purple' });
    const handle = runtime.startExecution(options('s'));
    const pending = collect(handle);
    await tick();
    client.emit('request', { id: 'q1', method: 'elicitation/create', params: { ...form, sessionId: 's' } });
    handle.resolveQuestion('q1', { 'Color?': 'green' });
    expect(client.respond).toHaveBeenLastCalledWith('q1', { action: 'accept', content: { q1: '2' } });
    client.emit('request', {
      id: 'p1',
      method: 'session/request_permission',
      params: {
        sessionId: 's',
        toolCall: { title: 'Run command?' },
        options: [{ optionId: 'no', name: 'Deny', kind: 'reject_once' }],
      },
    });
    handle.resolveQuestion('p1', { 'Run command?': 'Deny' });
    expect(client.respond).toHaveBeenLastCalledWith('p1', { outcome: { outcome: 'selected', optionId: 'no' } });
    handle.finish();
    expect((await pending).at(-1)?.subtype).toBe('error_cancelled');
    expect(client.calls.some((c) => c.method === 'session/cancel')).toBe(true);
    const next = collect(runtime.startExecution(options('s')));
    await tick();
    client.done('s');
    expect((await next).at(-1)?.is_error).toBe(false);
  });
  it('isolates concurrent sessions and finalizes disconnected streams', async () => {
    const first = collect(runtime.startExecution(options('a')));
    const second = collect(runtime.startExecution(options('b')));
    await tick();
    client.update('a', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'A' } });
    client.update('b', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'B' } });
    client.done('a');
    expect((await first).at(-1)?.result).toBe('A');
    client.emit('disconnected', new Error('connection lost'));
    expect((await second).at(-1)?.errors).toEqual(['connection lost']);
  });
  it('applies native model and reasoning selectors and rejects unsupported tool restrictions', async () => {
    await runtime.shutdown();
    runtime = new PersistentAntigravityExecutor(
      { ...config(), antigravity: { reasoningEffort: 'high' } },
      logger,
      client as any,
    );
    const pending = collect(runtime.startExecution({ ...options('s'), model: 'gemini' }));
    await tick();
    client.done('s');
    await pending;
    expect(client.calls).toContainEqual({
      method: 'session/set_config_option',
      params: { sessionId: 's', configId: 'model', value: 'gemini' },
    });
    expect(client.calls).toContainEqual({
      method: 'session/set_config_option',
      params: { sessionId: 's', configId: 'thought_level', value: 'high' },
    });
    expect((await collect(runtime.startExecution({ ...options(), allowedTools: [] }))).at(-1)?.is_error).toBe(true);
  });
  it('closes idle sessions on reset and shuts down preparing turns', async () => {
    const pending = collect(runtime.startExecution(options('s')));
    await tick();
    client.done('s');
    await pending;
    await runtime.resetChat('chat');
    expect(client.calls).toContainEqual({ method: 'session/close', params: { sessionId: 's' } });
    const turn = collect(runtime.startExecution(options()));
    await runtime.shutdown();
    expect((await turn).at(-1)?.is_error).toBe(true);
  });
});
describe('Antigravity bridge integration', () => {
  it('runs a task through question cards, user reply, file delivery, and native session reuse', async () => {
    const sender = {
      sendCard: vi.fn(async () => 'card'),
      updateCard: vi.fn(async () => true),
      sendQuestionCard: vi.fn(async () => 'question'),
      updateQuestionCard: vi.fn(async () => true),
      sendTextNotice: vi.fn(async () => {}),
      sendText: vi.fn(async () => {}),
      sendLocalFile: vi.fn(async () => true),
      sendImageFile: vi.fn(async () => true),
    };
    const bridge = new MessageBridge(config(), logger, sender as any) as any;
    const original = bridge.executor;
    bridge.executor = runtime;
    bridge.engineCache.set('antigravity', { engine: bridge.engine, executor: runtime });
    await original.shutdown();
    const incoming = (text: string, n: number) => ({
      messageId: `m${n}`,
      chatId: 'chat',
      chatType: 'p2p',
      userId: 'user',
      text,
    });
    try {
      const task = bridge.handleMessage(incoming('Please create a file', 1));
      await vi.waitFor(() => expect(client.prompts.size).toBe(1));
      const id = [...client.prompts.keys()][0];
      client.emit('request', { id: 'question', method: 'elicitation/create', params: { ...form, sessionId: id } });
      await vi.waitFor(() => expect(sender.sendQuestionCard).toHaveBeenCalled());
      await bridge.handleMessage(incoming('blue', 2));
      expect(client.respond).toHaveBeenCalledWith('question', { action: 'accept', content: { q1: '1' } });
      const outputs = client.calls.find((c) => c.method === 'session/new')!.params.additionalDirectories[0];
      fs.writeFileSync(path.join(outputs, 'result.txt'), 'blue');
      client.update(id, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Created blue file.' },
      });
      client.done(id);
      await task;
      expect(sender.sendLocalFile).toHaveBeenCalled();
      expect(bridge.getSessionManager().getSession('chat').sessionId).toBe(id);
      const next = bridge.handleMessage(incoming('Continue', 3));
      await vi.waitFor(() => expect(client.prompts.has(id)).toBe(true));
      client.done(id);
      await next;
      expect(client.calls.filter((c) => c.method === 'session/new')).toHaveLength(1);
    } finally {
      await bridge.destroyAsync();
    }
  });
});
