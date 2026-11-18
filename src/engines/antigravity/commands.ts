import type { IncomingMessage } from '../../types.js';
import type { ExecutorOptions } from '../claude/executor.js';
import type { PersistentAntigravityExecutor } from './persistent-executor.js';
interface Context {
  executor: PersistentAntigravityExecutor;
  options: ExecutorOptions;
  notice(title: string, text: string, color?: string): Promise<void>;
  outputs(key: string): string;
  stop(): void;
  setGoal(objective?: string): void;
}
/** Keep Antigravity-specific commands outside the bridge's existing Codex handler. */
export async function handleAntigravityCommand(msg: IncomingMessage, context: Context): Promise<boolean> {
  const [command] = msg.text.split(/\s+/);
  const normalized = command.toLowerCase();
  if (!['/goal', '/background', '/stop', '/team', '/teams', '/agent', '/agents'].includes(normalized)) return false;
  const args = msg.text.slice(command.length).trim();
  const { executor, options, notice } = context;
  const work = executor.work;
  try {
    if (normalized === '/stop') {
      context.stop();
      work.stopChat(msg.chatId);
      await notice('🛑 已停止', '当前执行和本聊天后台任务已停止，目标已暂停。');
    } else if (normalized === '/background') {
      const [sub, id] = args.split(/\s+/);
      if (!args || ['list', 'status'].includes(sub)) {
        const jobs = work.list(msg.chatId);
        await notice(
          'Antigravity 后台任务',
          jobs.length
            ? jobs.map((j) => `${j.id} · ${j.status} · ${j.prompt.slice(0, 80)}`).join('\n')
            : '暂无任务。使用 /background <任务> 启动。',
        );
      } else if (['stop', 'cancel'].includes(sub)) {
        if (!id) throw new Error('请指定任务 ID：/background stop <ID>');
        work.pause(id, msg.chatId);
        await notice('后台任务已停止', id);
      } else {
        const job = work.start(
          { ...options, outputsDir: context.outputs(`${msg.chatId}-background-${Date.now()}`) },
          args,
        );
        await notice('后台任务已启动', `${job.id}\n${args}\n完成后回传结果；需要补充信息时会提问。`);
      }
    } else if (normalized === '/goal') {
      const lower = args.toLowerCase();
      const current = work.goal(msg.chatId);
      if (!args || lower === 'status') {
        await notice(
          '🎯 Antigravity 目标',
          current
            ? `${current.prompt}\n状态：${current.status}\n/goal pause 暂停 · /goal resume 继续 · /goal clear 清除`
            : '当前没有目标。',
        );
      } else if (['pause', 'stop'].includes(lower)) {
        if (current) work.pause(current.id, msg.chatId);
        await notice('目标已暂停', current?.prompt || '当前没有目标。');
      } else if (['clear', 'off', 'reset', 'none', 'cancel'].includes(lower)) {
        work.clearGoal(msg.chatId);
        context.setGoal();
        await notice('目标已清除', '');
      } else if (['resume', 'continue'].includes(lower)) {
        if (!current) throw new Error('当前没有目标');
        work.resume(current.id, msg.chatId);
        await notice('目标已继续', current.prompt);
      } else {
        if (/(?:^|\s)--budget(?:=|\s)/.test(args))
          throw new Error('Antigravity ACP 不提供可靠的回合内 token 预算控制，暂不支持 --budget。');
        if (current && ['queued', 'running'].includes(current.status)) throw new Error('请先 /goal clear 清除当前目标');
        const job = work.start(
          { ...options, outputsDir: context.outputs(`${msg.chatId}-goal-${Date.now()}`) },
          args,
          'goal',
        );
        context.setGoal(args);
        await notice(
          '🎯 Antigravity 目标已启动',
          `${job.id}\n${args}\n使用原生 /goal 执行；/goal status 查看，/goal pause 暂停。`,
        );
      }
    } else {
      if (!args) await notice('Antigravity 团队', '使用 /team <任务> 调用原生 /teamwork 协作。');
      else {
        msg.text = `/teamwork ${args}`;
        return false;
      }
    }
  } catch (error) {
    await notice('Antigravity 命令执行失败', error instanceof Error ? error.message : String(error), 'red');
  }
  return true;
}
