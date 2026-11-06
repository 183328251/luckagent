import { buildSelectionCard, buildProgressCard, type SelectionCardItem } from './card.js';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from '../../types.js';
import type { CardActionEvent } from '../../feishu/event-handler.js';
import type { ApprovalReader } from './approval-client.js';
import type { PdfRenderer } from './renderer.js';
import type { Logger } from '../../utils/logger.js';
import { assertOwner, extractPrintData, printable } from './data.js';
import { PrintError, type BusinessHandler, type ReimbursementPrintConfig } from './types.js';

export interface PrintSender {
  sendText(chatId: string, text: string): Promise<unknown>;
  sendCard(chatId: string, content: string): Promise<string | undefined>;
  updateCard(messageId: string, content: string): Promise<boolean>;
  uploadFile(path: string, name: string, type: string): Promise<string | undefined>;
  sendFile(chatId: string, fileKey: string): Promise<unknown>;
}
interface Session {
  tenant: string;
  user: string;
  chat: string;
  message?: string;
  expires: number;
  options: Map<string, string>;
  claimed: Set<string>;
  financeReady: boolean;
}
export const PRINT_TRIGGER = '获取报销单';
export const PRINT_HELP = '请点击菜单或发送“获取报销单”，查看本人最新 5 笔可打印的报销单。';

/** Each instance belongs to one bot/app; sessions never cross application clients. */
export class ReimbursementPrintService implements BusinessHandler {
  private sessions = new Map<string, Session>();
  private querying = new Set<string>();
  private activePrints = new Set<string>();
  constructor(
    private config: ReimbursementPrintConfig,
    private approvals: ApprovalReader,
    private sender: PrintSender,
    private render: PdfRenderer,
    private logger: Logger,
    private now: () => number = Date.now,
  ) {
    if (
      !config.approvalCode ||
      !Number.isFinite(config.sessionTtlSeconds ?? 900) ||
      (config.sessionTtlSeconds ?? 900) < 1
    )
      throw new Error('Invalid reimbursement print configuration');
  }
  private sweep(): void {
    // Keep only bindings (no form data) briefly after expiry for a useful
    // expiry reply in the original DM. Authorization still checks expires.
    for (const [id, session] of this.sessions) if (session.expires + 900_000 <= this.now()) this.sessions.delete(id);
  }
  private async fail(chat: string, error: unknown, progressId?: string): Promise<void> {
    const category = error instanceof PrintError ? error.category : 'unexpected';
    this.logger.warn({ category }, 'Reimbursement print operation failed');
    const message = error instanceof PrintError ? error.userMessage : '处理报销单时遇到问题，请稍后重试或联系管理员。';
    if (progressId) await this.finishProgress(chat, progressId, 'error', message);
    else await this.sender.sendText(chat, message);
  }
  private async finishProgress(
    chat: string,
    messageId: string | undefined,
    status: 'complete' | 'error',
    text: string,
  ): Promise<void> {
    const card = buildProgressCard(status, text);
    if (messageId && (await this.sender.updateCard(messageId, card))) return;
    await this.sender.sendCard(chat, card);
  }

  async handleMessage(msg: IncomingMessage): Promise<void> {
    if (msg.chatType !== 'p2p') {
      await this.sender.sendText(msg.chatId, '请私聊报销打印助手，发送“获取报销单”。');
      return;
    }
    if (msg.text.trim() !== PRINT_TRIGGER) {
      await this.sender.sendCard(msg.chatId, buildProgressCard('error', PRINT_HELP, '🔴 使用提示'));
      return;
    }
    if (!msg.tenantKey || !msg.userId) {
      await this.fail(msg.chatId, new PrintError('无法核实当前会话身份，请联系管理员。', 'identity'));
      return;
    }
    this.sweep();
    const key = JSON.stringify([msg.tenantKey, msg.userId, msg.chatId]);
    if (this.querying.has(key)) {
      return;
    }
    this.querying.add(key);
    let progressId: string | undefined;
    try {
      progressId = await this.sender.sendCard(
        msg.chatId,
        buildProgressCard('thinking', '正在获取本人最新 5 笔可打印的报销单，请稍候。'),
      );
      const { records, financeReady } = await this.approvals.latest(msg.userId);
      const notice = financeReady ? '' : '\n财务审核中单据暂未启用，请联系管理员核对财务节点配置。';
      if (!records.length) {
        await this.finishProgress(msg.chatId, progressId, 'complete', `暂无符合条件的本人报销单。${notice}`);
        return;
      }
      const name = await this.approvals.name(msg.userId);
      const id = randomUUID();
      const session: Session = {
        tenant: msg.tenantKey,
        user: msg.userId,
        chat: msg.chatId,
        expires: this.now() + (this.config.sessionTtlSeconds ?? 900) * 1000,
        options: new Map(),
        claimed: new Set(),
        financeReady,
      };
      const items: SelectionCardItem[] = [];
      for (const record of records) {
        assertOwner(record, msg.userId, this.config.approvalCode);
        const data = extractPrintData(record, name);
        if (!record.instance_code) throw new PrintError('报销单信息不完整，请重新获取。', 'invalid_list');
        const option = randomUUID();
        session.options.set(option, record.instance_code);
        items.push({
          serial: record.serial_number,
          amount: data.total,
          date: data.date,
          title: data.title,
          status: record.status === 'APPROVED' ? '已通过' : '财务审核中',
          value: { action: 'reimbursement_print.select', session: id, option },
        });
      }
      // Store before sending so no callback can create an unbound session.
      // Until message ID is returned, any callback fails closed.
      if (this.sessions.size >= 1000) throw new PrintError('当前使用人数较多，请稍后重试。', 'capacity');
      this.sessions.set(id, session);
      const card = buildSelectionCard(items, this.config.sessionTtlSeconds ?? 900, notice);
      // Replace the thinking card so a completed query never leaves a stale
      // blue status message. Bind callbacks to whichever card actually exists.
      session.message =
        progressId && (await this.sender.updateCard(progressId, card))
          ? progressId
          : await this.sender.sendCard(msg.chatId, card);
      if (!session.message) {
        this.sessions.delete(id);
        throw new PrintError('报销选单发送失败，请重新获取报销单。', 'card_send');
      }
    } catch (error) {
      await this.fail(msg.chatId, error, progressId);
    } finally {
      this.querying.delete(key);
    }
  }
  /** Synchronous platform toast validation; no API calls or PDF work here. */
  validateCardAction(event: CardActionEvent): string | undefined {
    this.sweep();
    const id = typeof event.value.session === 'string' ? event.value.session : '';
    const option = typeof event.value.option === 'string' ? event.value.option : '';
    const s = this.sessions.get(id);
    // Invalid/forwarded callbacks never disclose the original card or data.
    if (
      event.value.action !== 'reimbursement_print.select' ||
      !s ||
      s.expires <= this.now() ||
      !event.tenantKey ||
      s.tenant !== event.tenantKey ||
      s.user !== event.userId ||
      s.chat !== event.chatId ||
      !s.message ||
      s.message !== event.messageId ||
      !s.options.has(option)
    ) {
      return '选单无效或已过期，请在原私聊重新发送“获取报销单”。';
    }
    if (s.claimed.has(option)) return '这笔打印请求已处理，请检查会话；如需补打，请重新获取报销单。';
    return undefined;
  }
  async handleCardAction(event: CardActionEvent): Promise<void> {
    if (event.value.action !== 'reimbursement_print.select') return;
    const id = typeof event.value.session === 'string' ? event.value.session : '';
    const option = typeof event.value.option === 'string' ? event.value.option : '';
    const s = this.sessions.get(id);
    if (s?.claimed.has(option)) return;
    const error = this.validateCardAction(event);
    if (error || !s) {
      this.logger.warn({ category: 'invalid_selection' }, 'Reimbursement card rejected');
      // Do not send potentially sensitive messages into an unverified/group chat.
      if (s && s.tenant === event.tenantKey && s.user === event.userId && s.chat === event.chatId)
        await this.sender.sendText(s.chat, error || '请重新发送“获取报销单”。');
      return;
    }
    const instance = s.options.get(option)!;
    const key = JSON.stringify([s.tenant, s.user, instance]);
    if (s.claimed.has(option) || this.activePrints.has(key)) return;
    // Claim synchronously, before the first await. Never automatically resend
    // after an ambiguous send result. A fresh selection explicitly requests a reprint.
    s.claimed.add(option);
    this.activePrints.add(key);
    let file: Awaited<ReturnType<PdfRenderer>> | undefined;
    let progressId: string | undefined;
    try {
      progressId = await this.sender.sendCard(
        s.chat,
        buildProgressCard('thinking', '已收到打印请求，正在核验并生成 PDF。'),
      );
      const detail = await this.approvals.detail(instance, s.user);
      assertOwner(detail, s.user, this.config.approvalCode);
      const financeReady = detail.status === 'PENDING' && s.financeReady && (await this.approvals.financeReady());
      if (!printable(detail, financeReady ? this.config.financeNodeIds || [] : []))
        throw new PrintError('这张报销单当前状态不符合打印条件，请重新获取报销单。', 'status_changed');
      const data = extractPrintData(detail, await this.approvals.name(s.user));
      file = await this.render(data);
      const fileKey = await this.sender.uploadFile(file.filePath, '报销单.pdf', 'pdf');
      if (!fileKey) throw new PrintError('报销单 PDF 上传失败，请重新获取报销单后重试。', 'upload');
      if (!(await this.sender.sendFile(s.chat, fileKey)))
        throw new PrintError('报销单文件未确认发送成功，请先检查会话；如未收到，请重新获取报销单后补打。', 'send');
      await this.finishProgress(s.chat, progressId, 'complete', '报销单 PDF 已发送，请下载后打印。');
      this.logger.info({ category: 'sent' }, 'Reimbursement PDF sent');
    } catch (error) {
      await this.fail(s.chat, error, progressId);
    } finally {
      this.activePrints.delete(key);
      if (file) await file.cleanup();
    }
  }
}
