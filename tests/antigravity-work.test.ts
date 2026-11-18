import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { AsyncQueue } from '../src/utils/async-queue.js';
import { AntigravityWork } from '../src/engines/antigravity/work.js';
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-work-'));
  vi.stubEnv('SESSION_STORE_DIR', root);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const options = () => ({
  cwd: root,
  prompt: '',
  abortController: new AbortController(),
  apiContext: { botName: 'test', chatId: 'chat' },
});
function fixture(limit = 1) {
  const handles: any[] = [];
  const execute = vi.fn((opts: any) => {
    const queue = new AsyncQueue<any>();
    const handle = {
      stream: queue[Symbol.asyncIterator](),
      resolveQuestion: vi.fn(),
      finish: vi.fn(() => {
        queue.enqueue({ type: 'result', is_error: true });
        queue.finish();
      }),
    };
    handles.push({ ...handle, opts, queue });
    return handle as any;
  });
  const work = new AntigravityWork({ name: 'test', maxConcurrentTasks: limit } as any, execute);
  return { work, handles, execute };
}
describe('Antigravity durable work', () => {
  it('limits concurrency and runs native goals in isolated sessions', async () => {
    const { work, handles, execute } = fixture();
    const delivered = vi.fn();
    work.on('result', delivered);
    const first = work.start(options(), 'finish project', 'goal');
    work.start(options(), 'other task');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(handles[0].opts.prompt).toBe('/goal finish project');
    expect(handles[0].opts.sessionId).toBeUndefined();
    expect(work.activity().queued).toBe(1);
    handles[0].queue.enqueue({ type: 'result', result: 'done' });
    handles[0].queue.finish();
    await tick();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(first.status).toBe('completed');
    expect(delivered).toHaveBeenCalledTimes(1);
    work.shutdown();
    await tick();
  });
  it('pauses a goal, answers native questions, then resumes its saved conversation', async () => {
    const { work, handles } = fixture();
    const question = vi.fn();
    work.on('question', question);
    const job = work.start(options(), 'goal', 'goal');
    handles[0].queue.enqueue({ type: 'system', session_id: 'native-id' });
    handles[0].queue.enqueue({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'q1',
            name: 'AskUserQuestion',
            input: { questions: [{ question: 'Color?', options: [{ label: 'blue' }] }] },
          },
        ],
      },
    });
    await tick();
    expect(question).toHaveBeenCalledOnce();
    expect(work.answerPending('chat', '1')).toBe(true);
    expect(handles[0].resolveQuestion).toHaveBeenCalledWith('q1', { 'Color?': 'blue' });
    work.pause(job.id, 'chat');
    await tick();
    expect(job.status).toBe('stopped');
    work.resume(job.id, 'chat');
    expect(handles[1].opts.sessionId).toBe('native-id');
    work.shutdown();
    await tick();
  });
  it('recovers running work and redelivers completed work after a restart', async () => {
    const first = fixture();
    const job = first.work.start(options(), 'persist me');
    first.handles[0].queue.enqueue({ type: 'system', session_id: 'saved-session' });
    await tick();
    first.work.shutdown();
    await tick();
    const second = fixture();
    second.work.restore();
    expect(second.handles[0].opts.sessionId).toBe('saved-session');
    second.handles[0].queue.enqueue({ type: 'result', result: 'done' });
    second.handles[0].queue.finish();
    await tick();
    second.work.shutdown();
    const third = fixture();
    const delivered = vi.fn();
    third.work.on('result', delivered);
    third.work.restore();
    expect(delivered).toHaveBeenCalledWith(
      expect.objectContaining({ job: expect.objectContaining({ id: job.id, status: 'completed' }) }),
    );
    expect(third.execute).not.toHaveBeenCalled();
    third.work.markDelivered(job.id);
    third.work.shutdown();
  });
});
