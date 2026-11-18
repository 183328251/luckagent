import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import type { Logger } from '../../utils/logger.js';
import type { AntigravityBotConfig } from '../../config.js';
import { resolveAntigravityPath } from './executor.js';

export interface RpcNotification {
  method: string;
  params: Record<string, any>;
}
export interface RpcRequest extends RpcNotification {
  id: string | number;
}

/** A bot-owned Antigravity app-server connection; no Claude process or global config is modified. */
export class AntigravityAcpClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private initializing?: Promise<void>;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve(value: any): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout> }
  >();
  private stopping = false;
  capabilities: Record<string, any> = {};
  version?: string;
  constructor(
    private logger: Logger,
    private config: AntigravityBotConfig = {},
    private cwd?: string,
  ) {
    super();
  }

  async start(): Promise<void> {
    if (this.initializing) return this.initializing;
    this.stopping = false;
    this.initializing = this.initialize();
    try {
      await this.initializing;
    } catch (error) {
      this.initializing = undefined;
      await this.close();
      throw error;
    }
  }

  private async initialize(): Promise<void> {
    const args = ['acp', '--sandbox'];
    if (this.config.skipPermissions) args.push('--dangerously-skip-permissions');
    const child = spawn(resolveAntigravityPath(this.config.executable), args, {
      env: { ...process.env },
      ...(this.cwd ? { cwd: this.cwd } : {}),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    this.child = child;
    let buffer = '';
    const decoder = new StringDecoder('utf8');
    const parse = (line: string) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && !msg.method) {
          const pending = this.pending.get(msg.id);
          if (!pending) return;
          this.pending.delete(msg.id);
          clearTimeout(pending.timer);
          if (msg.error) pending.reject(new Error(msg.error.message || 'Antigravity RPC error'));
          else pending.resolve(msg.result);
        } else if (msg.method && msg.id !== undefined) this.emit('request', msg as RpcRequest);
        else if (msg.method) this.emit('notification', msg as RpcNotification);
      } catch (error) {
        this.logger.warn({ error: String(error) }, 'Invalid Antigravity app-server message');
      }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) parse(line);
    });
    child.stderr.on('data', () => {
      /* Protocol errors are reported through RPC, not credential-bearing stderr. */
    });
    child.stdin.on('error', () => {});
    const failed = (error: Error) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.initializing = undefined;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(error);
      }
      this.pending.clear();
      if (!this.stopping) this.emit('disconnected', error);
    };
    child.once('error', failed);
    child.once('close', (code, signal) => {
      buffer += decoder.end();
      parse(buffer);
      failed(new Error(`Antigravity app-server exited (${signal || code})`));
    });
    const init = await this.callRaw('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'luckagent', version: '0.7.33' },
      clientCapabilities: { elicitation: { form: {} } },
    });
    if (init.protocolVersion !== 1) throw new Error('Unsupported ACP protocol version');
    this.capabilities = init.agentCapabilities ?? {};
    this.version = init.agentInfo?.version;
  }

  async call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.start();
    return this.callRaw(method, params);
  }
  private callRaw<T = any>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer =
        method === 'session/prompt'
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`Antigravity request timed out: ${method}`));
            }, 45000);
      timer?.unref();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  notify(method: string, params: Record<string, unknown>): void {
    this.write({ method, params });
  }
  reject(id: string | number, message: string): void {
    this.write({ id, error: { code: -32601, message } });
  }
  respond(id: string | number, result: Record<string, unknown>): void {
    this.write({ id, result });
  }
  private write(message: unknown): void {
    if (!this.child?.stdin.writable) throw new Error('Antigravity app-server is not connected');
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...(message as object) }) + '\n');
  }
  async close(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    this.child = undefined;
    this.initializing = undefined;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Antigravity app-server shutdown'));
    }
    this.pending.clear();
    if (!child?.pid) return;
    const pid = child.pid;
    const signal = (sig: NodeJS.Signals) => {
      try {
        if (process.platform === 'win32') child.kill(sig);
        else process.kill(-pid, sig);
      } catch {}
    };
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        signal('SIGKILL');
        resolve();
      }, 3000);
      timer.unref();
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      signal('SIGTERM');
    });
  }
}
