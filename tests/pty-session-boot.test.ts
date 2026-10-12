import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.setConfig({ testTimeout: 20_000 });
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * PtyClaudeSession boot robustness:
 *   - the Bypass Permissions disclaimer is accepted ONLY once the screen shows
 *     the pointer on "Yes, I accept" (claude 2.1.29x renders an index-less menu
 *     focused on "No, exit" — a blind "2" + Enter exits claude);
 *   - a resume id whose transcript was never written starts a fresh session
 *     instead of wedging every later turn on "No conversation found".
 *
 * node-pty is replaced by a scripted fake TUI that reacts to keystrokes.
 */

type Variant = 'indexless' | 'indexed-digit-focus' | 'digit-confirms' | 'unresponsive';

interface FakeTerm {
  args: string[];
  writes: string[];
  exitCode: number | null;
  emit(data: string): void;
}

const fake: { variant: Variant; term: FakeTerm | null } = { variant: 'indexless', term: null };

vi.mock('node-pty', () => ({
  spawn: (_file: string, args: string[]) => {
    let dataCb: ((d: string) => void) | null = null;
    let exitCb: ((e: { exitCode: number; signal?: number }) => void) | null = null;
    let focusYes = false;
    let inDialog = true;
    const variant = fake.variant;
    const indexed = variant !== 'indexless';

    const render = (lines: string[]) => dataCb?.('\x1b[2J\x1b[H' + lines.join('\r\n'));
    const drawDialog = () =>
      render([
        'WARNING: Claude Code running in Bypass Permissions mode',
        '',
        'In Bypass Permissions mode, Claude Code will not ask for your approval.',
        '',
        `${focusYes ? ' ' : '❯'} ${indexed ? '1. ' : ''}No, exit`,
        `${focusYes ? '❯' : ' '} ${indexed ? '2. ' : ''}Yes, I accept`,
        '',
        'Enter to confirm · Esc to cancel',
      ]);
    // Like real claude, the post-accept frame (welcome banner + input box) is
    // large enough to roll the dialog out of the idle detector's ring tail.
    const banner = Array.from({ length: 12 }, (_, i) => `│ Welcome to Claude Code — tip line ${i} ${'·'.repeat(40)} │`);
    const drawInput = () => render([...banner, '╭──────╮', '│ ❯    │', '╰──────╯', '  ? for shortcuts']);

    const term: FakeTerm & Record<string, unknown> = {
      args,
      writes: [],
      exitCode: null,
      emit: (d: string) => dataCb?.(d),
      onData: (cb: (d: string) => void) => {
        dataCb = cb;
        setTimeout(drawDialog, 20);
      },
      onExit: (cb: (e: { exitCode: number }) => void) => {
        exitCb = cb;
      },
      kill: () => {},
      write: (k: string) => {
        term.writes.push(k);
        if (!inDialog) return;
        if (k === '\r') {
          if (focusYes) {
            inDialog = false;
            setTimeout(drawInput, 20);
          } else {
            term.exitCode = 1;
            exitCb?.({ exitCode: 1 });
          }
          return;
        }
        if (variant === 'unresponsive') return;
        if (k === '\x1b[B' && variant === 'indexless') focusYes = true;
        if (k === '2' && variant === 'indexed-digit-focus') focusYes = true;
        if (k === '2' && variant === 'digit-confirms') {
          inDialog = false;
          setTimeout(drawInput, 20);
          return;
        }
        setTimeout(drawDialog, 20);
      },
    };
    fake.term = term;
    return term;
  },
}));

const { createPtyClaudeSession } = await import('../src/engines/claude/pty/pty-session.js');
const { claudeProjectsDir } = await import('../src/engines/claude/session-lister.js');

function logger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() } as any;
}

let home: string;
let cwd: string;
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-boot-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-boot-cwd-'));
  process.env.HOME = home; // ensureFolderTrusted / claudeProjectsDir use os.homedir()
  fake.term = null;
});

afterEach(() => {
  process.env.HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

function makeSession(opts: { resume?: string } = {}) {
  return createPtyClaudeSession({ cwd, settingsPath: '/dev/null', logger: logger(), ...opts }) as any;
}

/** Drive the bypass handling directly (skips ready()'s fixed 2.5s settle). */
async function waitIdle(s: any): Promise<void> {
  await new Promise((r) => setTimeout(r, 100)); // let the fake draw the dialog
  const started = Date.now();
  await s.waitForIdleInput();
  // Must reach a genuinely idle input box, not the 15s "typing anyway" timeout.
  expect(Date.now() - started).toBeLessThan(8_000);
  expect(s.log.warn).not.toHaveBeenCalledWith('pty-session: idle-input wait timed out — typing anyway');
}

describe('PtyClaudeSession — bypass disclaimer', () => {
  it('index-less menu (focus on "No, exit"): moves ↓ to "Yes, I accept" before Enter', async () => {
    fake.variant = 'indexless';
    const s = makeSession();
    await waitIdle(s);
    const t = fake.term!;
    expect(t.exitCode).toBeNull();
    expect(t.writes).toEqual(['\x1b[B', '\r']);
    expect(s.screen()).toContain('? for shortcuts');
    await s.dispose();
  });

  it('indexed menu where only the digit moves focus: falls back to "2", then Enter', async () => {
    fake.variant = 'indexed-digit-focus';
    const s = makeSession();
    await waitIdle(s);
    const t = fake.term!;
    expect(t.exitCode).toBeNull();
    expect(t.writes).toEqual(['\x1b[B', '2', '\r']);
    await s.dispose();
  });

  it('digit-select build that confirms immediately: no extra Enter needed', async () => {
    fake.variant = 'digit-confirms';
    const s = makeSession();
    await waitIdle(s);
    const t = fake.term!;
    expect(t.exitCode).toBeNull();
    expect(t.writes).toEqual(['\x1b[B', '2']);
    await s.dispose();
  });

  it('pointer cannot be confirmed: never presses Enter, fails fast with a clear error', async () => {
    fake.variant = 'unresponsive';
    const s = makeSession();
    const started = Date.now();
    await expect(waitIdle(s)).rejects.toThrow(/Bypass Permissions disclaimer/);
    expect(Date.now() - started).toBeLessThan(10_000); // well under the 15s idle timeout
    const t = fake.term!;
    expect(t.writes).not.toContain('\r');
    expect(t.writes).not.toContain('\x1b'); // Esc = "No, exit" too
    expect(t.exitCode).toBeNull();
    await s.dispose();
  });
});

describe('PtyClaudeSession — resume fallback', () => {
  it('resumes when the transcript exists', async () => {
    fake.variant = 'indexless';
    const id = '11111111-2222-3333-4444-555555555555';
    const dir = claudeProjectsDir(cwd);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), '{}\n');
    const s = makeSession({ resume: id });
    expect(s.resumed).toBe(true);
    expect(s.sessionId).toBe(id);
    expect(s.jsonlPath).toBe(path.join(dir, `${id}.jsonl`));
    expect(fake.term!.args).toEqual(expect.arrayContaining(['--resume', id]));
    expect(fake.term!.args).not.toContain('--session-id');
    await s.dispose();
  });

  it('starts a fresh session when the resume transcript was never written', async () => {
    fake.variant = 'indexless';
    const id = '797264bb-0000-0000-0000-000000000000';
    const s = makeSession({ resume: id });
    expect(s.resumed).toBe(false);
    expect(s.sessionId).not.toBe(id);
    expect(s.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.jsonlPath).toBe(path.join(claudeProjectsDir(cwd), `${s.sessionId}.jsonl`));
    const args = fake.term!.args;
    expect(args).not.toContain('--resume');
    expect(args).toEqual(expect.arrayContaining(['--session-id', s.sessionId]));
    await s.dispose();
  });

  it('no resume requested: self-generated id, not resumed', async () => {
    fake.variant = 'indexless';
    const s = makeSession();
    expect(s.resumed).toBe(false);
    expect(fake.term!.args).toEqual(expect.arrayContaining(['--session-id', s.sessionId]));
    await s.dispose();
  });
});
