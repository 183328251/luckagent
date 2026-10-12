import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AsyncQueue } from '../src/utils/async-queue.js';

/**
 * ptyQuery must report the session's ACTUAL id and must never hand the bridge
 * an id whose transcript was never written — otherwise sessions.db stores it
 * and every later `claude --resume <id>` dies with "No conversation found",
 * wedging the chat until /reset.
 */

interface FakeSession {
  sessionId: string;
  resumed?: boolean;
  jsonlPath: string;
  typePrompt: ReturnType<typeof vi.fn>;
  fireExit(code: number): void;
}

const ctl: {
  next: { sessionId: string; resumed?: boolean; jsonlPath: string; typeError?: Error };
  session: FakeSession | null;
  scannerOpts: { startAtEnd?: boolean } | null;
} = { next: { sessionId: 'new-id', jsonlPath: '' }, session: null, scannerOpts: null };

vi.mock('../src/engines/claude/pty/pty-session.js', () => ({
  createPtyClaudeSession: (opts: { onExit?: (i: { exitCode: number }) => void }) => {
    const { typeError, ...rest } = ctl.next;
    const s: FakeSession & Record<string, unknown> = {
      ...rest,
      typePrompt: vi.fn(async () => {
        if (typeError) throw typeError;
      }),
      fireExit: (code: number) => opts.onExit?.({ exitCode: code }),
      ready: async () => {},
      sendKeys: () => {},
      snapshot: () => '',
      screen: () => Array.from({ length: 30 }, (_, i) => `row ${i}   `).join('\n'),
      interrupt: async () => {},
      dispose: async () => {},
    };
    ctl.session = s;
    return s;
  },
}));

vi.mock('../src/engines/claude/pty/jsonl-scanner.js', () => ({
  createJsonlScanner: (opts: { startAtEnd?: boolean }) => {
    ctl.scannerOpts = opts;
    return {
      stop: () => {},
      [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
    };
  },
}));

const { ptyQuery } = await import('../src/engines/claude/pty/pty-query.js');

function logger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() } as any;
}

function fakeHookBridge() {
  let turnCb: (() => void) | null = null;
  return {
    writeSettings: async () => '/dev/null',
    onTurnComplete: (cb: () => void) => { turnCb = cb; },
    onTeamEvent: () => {},
    dispose: async () => {},
    fireStop: () => turnCb?.(),
  };
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-query-sid-'));
  ctl.session = null;
  ctl.scannerOpts = null;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function start(opts: { resume?: string; next: typeof ctl.next }) {
  ctl.next = opts.next;
  const prompt = new AsyncQueue<any>();
  const hookBridge = fakeHookBridge();
  const log = logger();
  const q = ptyQuery({
    prompt,
    options: { cwd: dir, resume: opts.resume, logger: log, hookBridge } as any,
  });
  const it = q[Symbol.asyncIterator]();
  const send = (text: string) =>
    prompt.enqueue({ type: 'user', message: { role: 'user', content: text } });
  return { q, it, send, hookBridge, log };
}

async function nextResult(it: AsyncIterator<any>): Promise<any> {
  for (;;) {
    const r = await it.next();
    if (r.done) throw new Error('stream ended without a result');
    if (r.value?.type === 'result') return r.value;
  }
}

const settle = () => new Promise((r) => setTimeout(r, 50));

describe('ptyQuery — session id reporting', () => {
  it('fresh fallback session: a successful turn reports the NEW id, not the stale resume id', async () => {
    const jsonl = path.join(dir, 'new-id.jsonl');
    const { q, it, send, hookBridge } = start({
      resume: 'stale-id',
      next: { sessionId: 'new-id', resumed: false, jsonlPath: jsonl },
    });
    send('hi');
    await settle();
    expect(ctl.session!.typePrompt).toHaveBeenCalledWith('hi');
    hookBridge.fireStop();
    const res = await nextResult(it);
    expect(res.is_error).toBe(false);
    expect(res.session_id).toBe('new-id');
    await q.dispose();
  });

  it('fresh fallback session: scanner reads from the start (startAtEnd=false)', async () => {
    const { q } = start({
      resume: 'stale-id',
      next: { sessionId: 'new-id', resumed: false, jsonlPath: path.join(dir, 'x.jsonl') },
    });
    await settle();
    expect(ctl.scannerOpts?.startAtEnd).toBe(false);
    await q.dispose();
  });

  it('genuine resume: scanner skips the existing transcript (startAtEnd=true)', async () => {
    const { q } = start({
      resume: 'old-id',
      next: { sessionId: 'old-id', resumed: true, jsonlPath: path.join(dir, 'old-id.jsonl') },
    });
    await settle();
    expect(ctl.scannerOpts?.startAtEnd).toBe(true);
    await q.dispose();
  });

  it('claude exits before writing its transcript: error result carries NO session id', async () => {
    const { it, send, log } = start({
      next: { sessionId: 'never-written', jsonlPath: path.join(dir, 'never-written.jsonl') },
    });
    send('hi');
    await settle();
    ctl.session!.fireExit(1);
    const res = await nextResult(it);
    expect(res.is_error).toBe(true);
    expect(res.session_id).toBe('');
    // The exit log carries only the trimmed last 14 screen rows.
    const exitLog = log.warn.mock.calls.find((c: any[]) => c[1] === 'ptyQuery: claude exited unexpectedly');
    expect(exitLog?.[0].screenTail).toBe(Array.from({ length: 14 }, (_, i) => `row ${i + 16}`).join('\n'));
  });

  it('claude exits after the transcript exists: error result keeps the session id', async () => {
    const jsonl = path.join(dir, 'live.jsonl');
    fs.writeFileSync(jsonl, '{}\n');
    const { it, send } = start({ next: { sessionId: 'live', jsonlPath: jsonl } });
    send('hi');
    await settle();
    ctl.session!.fireExit(1);
    const res = await nextResult(it);
    expect(res.is_error).toBe(true);
    expect(res.session_id).toBe('live');
  });

  it('typePrompt fails (blocked boot dialog): turn closes with the cause, no session id, stream ends', async () => {
    const { it, send } = start({
      next: {
        sessionId: 'never-written',
        jsonlPath: path.join(dir, 'never-written.jsonl'),
        typeError: new Error('pty-session: claude is blocked on the Bypass Permissions disclaimer'),
      },
    });
    send('hi');
    const res = await nextResult(it);
    expect(res.is_error).toBe(true);
    expect(res.result).toMatch(/Bypass Permissions disclaimer/);
    expect(res.session_id).toBe('');
    // Exactly one result, then the stream finishes.
    for (;;) {
      const r = await it.next();
      if (r.done) break;
      expect(r.value?.type).not.toBe('result');
    }
  });
});
