import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { BotConfigBase } from '../../config.js';
import type { ExecutionHandle, ExecutorOptions, SDKMessage } from '../claude/executor.js';

export interface AntigravityJob {
  id: string;
  chatId: string;
  prompt: string;
  cwd: string;
  outputsDir?: string;
  model?: string;
  threadId?: string;
  createdAt: number;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'stopped';
  result?: string;
  error?: string;
  delivered?: boolean;
  kind: 'background' | 'goal';
}
interface PendingQuestion {
  id: string;
  questions: any[];
  index: number;
  answers: Record<string, string>;
}
/** Durable dispatch only. Native /goal owns its reasoning loop; no fabricated completion markers. */
export class AntigravityWork extends EventEmitter {
  private jobs = new Map<string, AntigravityJob>();
  private handles = new Map<string, ExecutionHandle>();
  private questions = new Map<string, PendingQuestion>();
  private stopping = false;
  private restored = false;
  private store: string;
  constructor(
    private config: BotConfigBase,
    private execute: (options: ExecutorOptions) => ExecutionHandle,
  ) {
    super();
    this.store = path.join(
      process.env.SESSION_STORE_DIR || path.join(os.homedir(), '.luckagent'),
      `antigravity-work-${config.name.replace(/[^\w-]/g, '_')}.json`,
    );
    try {
      for (const job of JSON.parse(fs.readFileSync(this.store, 'utf8')).jobs ?? []) this.jobs.set(job.id, job);
    } catch {
      /* first run */
    }
  }
  private save(): void {
    fs.mkdirSync(path.dirname(this.store), { recursive: true });
    const terminal = [...this.jobs.values()]
      .filter((j) => !['queued', 'running'].includes(j.status) && j.delivered)
      .slice(-200);
    const retained = [...this.jobs.values()].filter((j) => ['queued', 'running'].includes(j.status) || !j.delivered);
    const temporary = this.store + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({ jobs: [...terminal, ...retained] }) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, this.store);
  }
  start(options: ExecutorOptions, prompt: string, kind: AntigravityJob['kind'] = 'background'): AntigravityJob {
    if (this.stopping) throw new Error('Antigravity runtime is shutting down');
    if (!options.apiContext?.chatId) throw new Error('Background tasks require a chat');
    const job: AntigravityJob = {
      id: crypto.randomUUID().slice(0, 8),
      chatId: options.apiContext.chatId,
      prompt,
      cwd: options.cwd,
      outputsDir: options.outputsDir,
      model: options.model,
      createdAt: Date.now(),
      status: 'queued',
      kind,
    };
    this.jobs.set(job.id, job);
    this.save();
    this.pump();
    return job;
  }
  list(chatId: string): AntigravityJob[] {
    return [...this.jobs.values()].filter((j) => j.chatId === chatId).slice(-30);
  }
  goal(chatId: string): AntigravityJob | undefined {
    return [...this.jobs.values()].filter((j) => j.chatId === chatId && j.kind === 'goal').at(-1);
  }
  pause(id: string, chatId: string): void {
    const job = this.jobs.get(id);
    if (!job || job.chatId !== chatId) throw new Error('任务不存在');
    if (!['queued', 'running'].includes(job.status)) return;
    job.status = 'stopped';
    this.save();
    this.questions.delete(id);
    this.handles.get(id)?.finish();
  }
  resume(id: string, chatId: string): void {
    const job = this.jobs.get(id);
    if (!job || job.chatId !== chatId || job.kind !== 'goal') throw new Error('目标不存在');
    if (['queued', 'running'].includes(job.status)) return;
    if (this.handles.has(id)) throw new Error('目标正在停止，请稍后重试');
    job.status = 'queued';
    job.delivered = false;
    this.save();
    this.pump();
  }
  clearGoal(chatId: string): void {
    const job = this.goal(chatId);
    if (!job) return;
    this.pause(job.id, chatId);
    this.jobs.delete(job.id);
    this.save();
  }
  stopChat(chatId: string): void {
    for (const job of this.jobs.values()) if (job.chatId === chatId) this.pause(job.id, chatId);
  }
  markDelivered(id: string): void {
    const job = this.jobs.get(id);
    if (job) {
      job.delivered = true;
      this.save();
    }
  }
  activity(): { activeChats: string[]; queued: number } {
    return {
      activeChats: [...new Set([...this.jobs.values()].filter((j) => j.status === 'running').map((j) => j.chatId))],
      queued: [...this.jobs.values()].filter((j) => j.status === 'queued').length,
    };
  }
  private pump(): void {
    if (this.stopping) return;
    const limit = Math.max(1, this.config.maxConcurrentTasks || 2);
    for (const job of this.jobs.values()) {
      if (this.handles.size >= limit) break;
      if (job.status === 'queued' && !this.handles.has(job.id)) void this.run(job);
    }
  }
  private async run(job: AntigravityJob): Promise<void> {
    job.status = 'running';
    this.save();
    let result: SDKMessage | undefined;
    try {
      if (job.outputsDir) fs.mkdirSync(job.outputsDir, { recursive: true });
      const handle = this.execute({
        prompt: job.kind === 'goal' ? `/goal ${job.prompt}` : job.prompt,
        cwd: job.cwd,
        outputsDir: job.outputsDir,
        sessionId: job.threadId,
        model: job.model,
        abortController: new AbortController(),
        apiContext: { botName: this.config.name, chatId: job.chatId },
      });
      this.handles.set(job.id, handle);
      for await (const message of handle.stream) {
        if (message.session_id && message.session_id !== job.threadId) {
          job.threadId = message.session_id;
          this.save();
        }
        for (const block of message.message?.content ?? [])
          if (block.type === 'tool_use' && block.name === 'AskUserQuestion') {
            const input = block.input as { questions?: any[] };
            if (block.id && input.questions?.length) {
              this.questions.set(job.id, { id: block.id, questions: input.questions, index: 0, answers: {} });
              this.emitQuestion(job);
            }
          }
        if (message.type === 'result') result = message;
      }
      if (this.stopping || this.jobs.get(job.id)?.status === 'stopped' || !this.jobs.has(job.id)) return;
      job.status = !result || result.is_error ? 'failed' : 'completed';
      job.result = result?.result;
      job.error = result?.errors?.join('; ');
    } catch (error) {
      if (this.stopping || this.jobs.get(job.id)?.status === 'stopped' || !this.jobs.has(job.id)) return;
      job.status = 'failed';
      job.error = String(error);
    } finally {
      this.questions.delete(job.id);
      this.handles.delete(job.id);
      if (!this.stopping) {
        this.save();
        if (['completed', 'failed'].includes(job.status) && this.jobs.has(job.id)) this.emitResult(job, result);
        this.pump();
      }
    }
  }
  private emitQuestion(job: AntigravityJob): void {
    const question = this.questions.get(job.id);
    if (question) this.emit('question', { chatId: job.chatId, questions: [question.questions[question.index]] });
  }
  answerPending(chatId: string, text: string): boolean {
    const job = [...this.jobs.values()].find((j) => j.chatId === chatId && this.questions.has(j.id));
    if (!job) return false;
    const pending = this.questions.get(job.id)!;
    const question = pending.questions[pending.index];
    const index = /^\d+$/.test(text.trim()) ? Number(text.trim()) - 1 : -1;
    pending.answers[question.question] = question.options?.[index]?.label ?? text;
    if (++pending.index < pending.questions.length) this.emitQuestion(job);
    else {
      this.handles.get(job.id)?.resolveQuestion(pending.id, pending.answers);
      this.questions.delete(job.id);
    }
    return true;
  }
  private emitResult(job: AntigravityJob, result?: SDKMessage): void {
    this.emit('result', {
      job,
      result: result ?? {
        type: 'result',
        subtype: job.status === 'completed' ? 'success' : 'error_during_execution',
        result: job.result,
        is_error: job.status !== 'completed',
        errors: job.error ? [job.error] : undefined,
      },
    });
  }
  restore(): void {
    if (this.restored || this.stopping) return;
    this.restored = true;
    for (const job of this.jobs.values()) {
      if (['queued', 'running'].includes(job.status)) job.status = 'queued';
      else if (!job.delivered && ['completed', 'failed'].includes(job.status)) this.emitResult(job);
    }
    this.save();
    this.pump();
  }
  shutdown(): void {
    this.stopping = true;
    // Retain queued/running records; the next bridge resumes their explicit native session IDs.
    this.save();
    for (const handle of this.handles.values()) handle.finish();
    this.questions.clear();
  }
}
