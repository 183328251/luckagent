/**
 * PtyClaudeSession — drives a REAL interactive `claude` TUI process via node-pty.
 *
 * Owns: process spawn, lifecycle, keystroke input, readiness detection, jsonl path.
 * Does NOT own: jsonl reading, message adapting, hooks.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
// @xterm/headless is CommonJS — import the default and destructure.
import xterm from '@xterm/headless';
const { Terminal } = xterm;
type XtermTerminal = InstanceType<typeof Terminal>;
import type { Logger } from '../../../utils/logger.js';
import { claudeProjectsDir } from '../session-lister.js';
import type {
  PtyClaudeSession as IPtyClaudeSession,
  PtyClaudeSessionOptions,
} from './contract.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Max bytes kept in the PTY output ring buffer. */
const RING_CAP = 64 * 1024;

class PtyClaudeSessionImpl implements IPtyClaudeSession {
  readonly sessionId: string;
  readonly resumed: boolean;
  readonly jsonlPath: string;

  private term: IPty | null = null;
  private ring = '';
  /**
   * Headless terminal emulator fed the SAME PTY bytes as `ring`. Unlike the
   * append-log `ring`, this maintains the true SCREEN GRID (cursor moves
   * resolved, no duplicated/glued frames), so `screen()` can be parsed reliably
   * for structured menus (the AskUserQuestion question/options/checkboxes). The
   * raw `ring`/`snapshot()` is kept for the existing substring-based detectors.
   */
  private vt: XtermTerminal;
  private readonly cols: number;
  private readonly rows: number;
  private readyPromise: Promise<void> | null = null;
  private disposed = false;
  private readonly log: Logger;
  private readonly opts: PtyClaudeSessionOptions;

  constructor(opts: PtyClaudeSessionOptions) {
    this.opts = opts;
    this.log = opts.logger;
    this.cols = opts.cols ?? 120;
    this.rows = opts.rows ?? 40;
    this.vt = new Terminal({ cols: this.cols, rows: this.rows, allowProposedApi: true });

    // Compute jsonl paths under ~/.claude/projects/<sanitized-cwd>/ using
    // Claude Code's exact naming rule (claudeProjectsDir) — any mismatch
    // (relative cwd, '.', spaces, '_', CJK, symlinks) makes the scanner tail a
    // file that never exists and the Feishu card renders blank.
    const projectsDir = claudeProjectsDir(opts.cwd);

    // Session id: adopt resume id or self-generate. A resume id whose
    // transcript was never written (claude died at boot, after the bridge had
    // already persisted our self-generated id) makes `claude --resume` exit 1
    // with "No conversation found" on EVERY later turn — the chat is wedged
    // until /reset. Start a fresh session instead; the new id flows back to the
    // bridge with the next result and replaces the bad one.
    let resume = opts.resume;
    if (resume && !fs.existsSync(path.join(projectsDir, `${resume}.jsonl`))) {
      this.log.warn({ resume, projectsDir }, 'pty-session: resume transcript missing — starting a fresh session');
      resume = undefined;
    }
    this.resumed = Boolean(resume);
    this.sessionId = resume ?? randomUUID();
    this.jsonlPath = path.join(projectsDir, `${this.sessionId}.jsonl`);

    this.spawn();
  }

  /**
   * Pre-accept the per-folder trust dialog for `cwd` in ~/.claude.json.
   *
   * On the FIRST interactive run in a directory, `claude` shows a blocking
   * "Is this a project you trust?" prompt — even under
   * --dangerously-skip-permissions. That dialog renders a `❯` menu pointer,
   * which fools waitForReady()'s input-box detector: we then "type" the
   * prompt into the menu and the session is corrupted. luckagent uses a fresh
   * per-chat working directory, so EVERY new chat's first turn would hit
   * this. Seeding `projects[cwd].hasTrustDialogAccepted = true` (exactly how
   * claude records an accepted dialog) suppresses it entirely.
   *
   * Best-effort + targeted: we read-modify-write only the single nested flag
   * so we don't clobber the rest of the file. Failures are logged, not fatal.
   */
  private ensureFolderTrusted(cwd: string): void {
    const cfgPath = path.join(os.homedir(), '.claude.json');
    try {
      let cfg: Record<string, any> = {};
      const fileExists = fs.existsSync(cfgPath);
      try {
        if (fileExists) cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      } catch (err) {
        // An EXISTING but unparseable ~/.claude.json must never be rewritten
        // from {} — that would clobber login/onboarding state. Skip seeding.
        this.log.warn({ err, cfgPath }, 'pty-session: ~/.claude.json exists but is unreadable — NOT seeding (would clobber it)');
        return;
      }
      if (!cfg.projects || typeof cfg.projects !== 'object') cfg.projects = {};
      const entry = (cfg.projects[cwd] && typeof cfg.projects[cwd] === 'object')
        ? cfg.projects[cwd]
        : (cfg.projects[cwd] = {});
      // Two one-time dialogs would otherwise wedge a headless PTY on a fresh
      // machine: the per-folder trust prompt AND the --dangerously-skip-
      // permissions acceptance screen ("WARNING: Bypass Permissions mode",
      // default = "No, exit" — a fresh Mac mini died there in the field).
      // Both are plain flags in ~/.claude.json; pre-seed them exactly as an
      // interactive acceptance would.
      const trustDone = entry.hasTrustDialogAccepted === true;
      const bypassDone = cfg.bypassPermissionsModeAccepted === true;
      if (trustDone && bypassDone) return; // nothing to seed
      entry.hasTrustDialogAccepted = true;
      cfg.bypassPermissionsModeAccepted = true;
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      let verified = false;
      try {
        verified = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')).bypassPermissionsModeAccepted === true;
      } catch { /* verified stays false */ }
      this.log.info(
        { cwd, cfgPath, seededTrust: !trustDone, seededBypass: !bypassDone, readBackOk: verified, bytes: fs.statSync(cfgPath).size },
        'pty-session: pre-accepted trust/bypass flags in ~/.claude.json',
      );
    } catch (err) {
      this.log.warn({ err, cwd }, 'pty-session: failed to pre-accept folder trust (may hit trust dialog)');
    }
  }

  private spawn(): void {
    const { opts } = this;
    this.ensureFolderTrusted(opts.cwd);
    const args: string[] = [];

    if (this.resumed) {
      args.push('--resume', this.sessionId);
    } else {
      args.push('--session-id', this.sessionId);
    }

    args.push('--settings', opts.settingsPath);
    args.push('--dangerously-skip-permissions');

    if (opts.appendSystemPrompt) {
      args.push('--append-system-prompt', opts.appendSystemPrompt);
    }
    if (opts.model) {
      args.push('--model', opts.model);
    }

    // Build the child env: process.env + caller overrides.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    if (opts.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        if (v !== undefined) env[k] = v;
      }
    }
    // A PTY session is INTERACTIVE by definition. The parent (luckagent) runs
    // under the Agent SDK, so its env carries CLAUDE_CODE_ENTRYPOINT=sdk-cli /
    // CLAUDECODE. We MUST strip those so the spawned `claude` uses the
    // interactive entrypoint marker — that marker is what selects the Claude
    // Code SUBSCRIPTION billing pool (vs the Agent-SDK credit pool) post
    // June-2026. ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN are deliberately
    // KEPT so traffic still routes through TeamClaude for Max-account load
    // balancing — the entrypoint marker passes through that transparent proxy.
    for (const k of ['CLAUDE_CODE_ENTRYPOINT', 'CLAUDECODE']) {
      delete env[k];
    }

    const claudePath = opts.pathToClaudeExecutable ?? 'claude';
    const cols = opts.cols ?? 120;
    const rows = opts.rows ?? 40;

    // Spawn with the SAME absolute cwd used to derive jsonlPath, so claude's
    // own jsonl-dir derivation matches ours regardless of luckagent's process cwd.
    const spawnCwd = path.resolve(opts.cwd);
    this.log.info({ sessionId: this.sessionId, claudePath, args, cwd: spawnCwd }, 'pty-session: spawning claude');

    try {
      this.term = pty.spawn(claudePath, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: spawnCwd,
        env,
      });
    } catch (err: any) {
      // posix_spawnp gives no context — attach the exact file we tried so a
      // bad resolution (broken symlink, PM2-PATH-only hit) is one log away.
      throw new Error(
        `pty spawn failed for "${claudePath}" (cwd ${spawnCwd}): ${err?.message || err}. ` +
        'Check the path exists and is executable; override with CLAUDE_EXECUTABLE_PATH in .env if needed.',
        { cause: err },
      );
    }

    this.term.onData((data: string) => {
      this.ring += data;
      if (this.ring.length > RING_CAP) {
        this.ring = this.ring.slice(-RING_CAP);
      }
      // Feed the same bytes to the headless screen emulator (best-effort).
      try { this.vt.write(data); } catch { /* ignore parser hiccups */ }
    });

    this.term.onExit(({ exitCode, signal }) => {
      this.log.info({ exitCode, signal }, 'pty-session: claude process exited');
      try {
        this.opts.onExit?.({ exitCode, signal });
      } catch (err) {
        this.log.warn({ err }, 'pty-session: onExit callback threw');
      }
    });
  }

  ready(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.waitForReady();
    return this.readyPromise;
  }

  private async waitForReady(): Promise<void> {
    const TIMEOUT = 30_000;
    const POLL = 150;
    const SETTLE = 2500;
    const start = Date.now();

    while (Date.now() - start < TIMEOUT) {
      if (/❯/.test(this.ring)) {
        this.log.info('pty-session: TUI input box detected, settling...');
        await sleep(SETTLE);
        return;
      }
      await sleep(POLL);
    }

    throw new Error(
      `pty-session: timeout (${TIMEOUT}ms) waiting for TUI input box (❯). ` +
        `Last 500 chars: ${this.ring.slice(-500)}`,
    );
  }

  async typePrompt(text: string): Promise<void> {
    await this.ready(); // boot: wait for the TUI to first come up
    // Per-call readiness: ready() is memoized after boot, so on its own it would
    // let us type the INSTANT a turn is requested — even while claude is still
    // mid-interrupt. That's the "no response" bug: after a keep-planning Esc
    // (ExitPlanMode cancel) claude is briefly settling the interrupt and is NOT
    // at a clean input box; keystrokes typed then are dropped and the prompt is
    // never submitted. Wait for the TUI to actually return to an idle input box
    // before typing (best-effort: proceeds after a timeout so a session never
    // wedges on a missed heuristic).
    await this.waitForIdleInput();
    if (!this.term || this.disposed) {
      throw new Error('pty-session: cannot type — session disposed');
    }

    this.log.info({ len: text.length }, 'pty-session: typing prompt');

    // Type char-by-char into the PTY (interactive input). claude can exit
    // mid-loop (e.g. died on an onboarding screen) — fail with context, not
    // a null-deref TypeError.
    for (const ch of text) {
      if (!this.term || this.disposed) {
        throw new Error('pty-session: claude exited while the prompt was being typed');
      }
      this.term.write(ch);
    }

    await sleep(800);
    if (!this.term || this.disposed) {
      throw new Error('pty-session: claude exited before the prompt could be submitted');
    }
    this.term.write('\r');
    await sleep(1500);
    if (!this.term || this.disposed) return; // submitted; claude may have exited already
    // Double-Enter safeguard: the TUI sometimes needs a second Enter to submit.
    this.term.write('\r');
  }

  /**
   * Wait until the TUI is at an IDLE input box, ready to accept a new prompt.
   *
   * The snapshot is an append-log of PTY output (not a screen buffer), so we
   * read only the most-recent slice — the latest redraw — and key off what
   * claude actively rewrites there:
   *   - "esc to interrupt" in the live footer ⟶ the model is generating.
   *   - a menu footer ("enter to select", "ctrl-g to edit", "shift+tab to
   *     approve") or a `❯` pointing at a numbered option ⟶ a blocking menu is up
   *     (driven separately; never type a prompt into it).
   *   - otherwise, with the `❯` input box present ⟶ idle and ready.
   * We require the idle state to hold across a couple polls so a single
   * mid-redraw frame doesn't trip us, and cap the wait so a missed heuristic
   * degrades to today's behaviour (type anyway) rather than wedging the turn.
   */
  private async waitForIdleInput(): Promise<void> {
    const TIMEOUT = 15_000;
    const POLL = 200;
    const STABLE_MS = 700;
    const start = Date.now();
    let idleSince = 0;
    let bypassAnswered = false;
    while (Date.now() - start < TIMEOUT) {
      const tail = this.snapshot().slice(-700);
      const sq = tail.toLowerCase().replace(/\s+/g, '');
      // One-time acceptance screens can still appear if the pre-seeded
      // ~/.claude.json flag got clobbered (e.g. a concurrently-open
      // interactive claude rewriting its config — seen in the field).
      // Recognize the bypass-permissions disclaimer and accept it ourselves.
      // Since claude 2.1.29x the menu is index-less with focus on "No, exit",
      // so a blind digit + Enter EXITS claude: only press Enter once the screen
      // confirms the pointer sits on "Yes, I accept".
      if (!bypassAnswered && sq.includes('bypasspermissionsmode') && sq.includes('yes,iaccept')) {
        bypassAnswered = true;
        idleSince = 0;
        this.log.warn('pty-session: bypass-permissions dialog detected despite seeding — selecting "Yes, I accept"');
        const focus = await this.focusBypassAccept();
        if (focus === 'focused') {
          this.term?.write('\r');
          await sleep(600);
        } else if (focus === 'failed') {
          // Esc and Enter both mean "No, exit" here, and typing the prompt into
          // the menu would end the same way — fail the turn with a clear cause
          // instead of timing out into a dead process.
          this.log.error(
            { screen: this.screen().slice(-800) },
            'pty-session: could not focus "Yes, I accept" — NOT pressing Enter (it would pick "No, exit")',
          );
          throw new Error(
            'pty-session: claude is blocked on the Bypass Permissions disclaimer and it could not be auto-accepted. ' +
              'Add "skipDangerousModePermissionPrompt": true to ~/.claude/settings.json (or run claude ' +
              '--dangerously-skip-permissions once interactively and accept), then retry.',
          );
        }
        // 'gone': the key itself resolved the menu (legacy digit-select).
        continue;
      }
      const running = sq.includes('esctointerrupt');
      const menuUp =
        sq.includes('entertoselect') ||
        sq.includes('ctrl-gtoedit') ||
        sq.includes('shift+tabtoapprove') ||
        /❯\d\./.test(sq); // pointer on a numbered menu option
      const hasInputBox = tail.includes('❯');
      if (hasInputBox && !running && !menuUp) {
        if (!idleSince) idleSince = Date.now();
        if (Date.now() - idleSince >= STABLE_MS) return;
      } else {
        idleSince = 0;
      }
      await sleep(POLL);
    }
    this.log.warn('pty-session: idle-input wait timed out — typing anyway');
  }

  /**
   * Move the bypass-disclaimer menu pointer onto "Yes, I accept". Tries ↓
   * first (works for both indexed and index-less menus), then the legacy "2"
   * digit. Returns:
   *   - 'focused' — the screen shows `❯` on "Yes, I accept"; caller presses Enter.
   *   - 'gone'    — the dialog vanished after a key (a digit-select build that
   *                 confirms immediately); nothing left to press.
   *   - 'failed'  — pointer could not be confirmed; caller must NOT press Enter.
   */
  private async focusBypassAccept(): Promise<'focused' | 'gone' | 'failed'> {
    const onAccept = () => /❯\s*(?:\d\.\s*)?Yes, I accept/.test(this.screen());
    const dialogShown = () => this.screen().includes('Yes, I accept');
    // The ring (detector) can run ahead of the headless screen grid; wait for
    // the grid to show the dialog so "gone" below can't be a false positive.
    for (let i = 0; i < 10 && !dialogShown(); i++) await sleep(150);
    if (!dialogShown()) return 'failed';
    if (onAccept()) return 'focused';
    for (const key of ['\x1b[B', '2']) {
      if (!this.term || this.disposed) return 'failed';
      this.term.write(key);
      for (let i = 0; i < 8; i++) {
        await sleep(150);
        if (onAccept()) return 'focused';
        if (!dialogShown()) return 'gone';
      }
    }
    return 'failed';
  }

  async interrupt(): Promise<void> {
    if (!this.term || this.disposed) return;
    this.log.info('pty-session: sending interrupt (ESC + Ctrl-C)');
    this.term.write('\x1b');
    await sleep(100);
    this.term.write('\x03');
    await sleep(100);
  }

  /**
   * Write raw bytes to the PTY without any prompt-submit framing. Used by the
   * interactive-tool keystroke layer to drive native TUI menus (AskUserQuestion
   * / ExitPlanMode): digit selects, arrow keys navigate, `\r` confirms. Unlike
   * typePrompt(), this does NOT wait/double-Enter — the caller composes the
   * exact key sequence.
   */
  sendKeys(data: string): void {
    if (!this.term || this.disposed) return;
    this.term.write(data);
  }

  /**
   * Return an ANSI-stripped snapshot of the recent PTY output ring. The
   * keystroke layer parses this to detect a rendered menu and (for the dynamic
   * ExitPlanMode menu) locate which numbered option to press. Control bytes and
   * SGR/cursor/OSC escapes are removed so simple text regexes work.
   */
  snapshot(): string {
    /* eslint-disable no-control-regex -- stripping ANSI/control bytes from PTY output is intentional here */
    return this.ring
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\x1b[()][AB0]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
    /* eslint-enable no-control-regex */
  }

  /**
   * Return the CURRENT terminal SCREEN as clean text rows (the visible
   * viewport), reconstructed from the headless emulator. Cursor positioning is
   * resolved into a proper grid, so menu structure — the AskUserQuestion
   * question, numbered options, `[ ]` checkboxes, and tab bar — reads back
   * exactly as displayed, with no append-log duplication or glued spacing.
   * Trailing blank lines are trimmed.
   */
  screen(): string {
    try {
      const buf = this.vt.buffer.active;
      const rows: string[] = [];
      for (let y = buf.baseY; y < buf.baseY + this.rows; y++) {
        const line = buf.getLine(y);
        rows.push(line ? line.translateToString(true) : '');
      }
      return rows.join('\n').replace(/\s+$/, '');
    } catch {
      return '';
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (!this.term) return;

    this.log.info('pty-session: disposing');
    this.term.write('\x03');
    await sleep(300);
    this.term.kill();
    this.term = null;
    try { this.vt.dispose(); } catch { /* ignore */ }
  }
}

/** Factory: create a PtyClaudeSession from options. */
export function createPtyClaudeSession(
  options: PtyClaudeSessionOptions,
): IPtyClaudeSession {
  return new PtyClaudeSessionImpl(options);
}
