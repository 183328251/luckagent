import { describe, expect, it, vi } from 'vitest';
import type * as lark from '@larksuiteoapi/node-sdk';
import { buildSelectionCard } from '../src/modules/reimbursement-print/card.js';
import { ApprovalClient } from '../src/modules/reimbursement-print/approval-client.js';
import {
  assertOwner,
  extractPrintData,
  moneyCents,
  moneyText,
  printable,
} from '../src/modules/reimbursement-print/data.js';
import { ReimbursementPrintService } from '../src/modules/reimbursement-print/service.js';
import type { ApprovalDetail } from '../src/modules/reimbursement-print/types.js';
import type { Logger } from '../src/utils/logger.js';
import { createReceiveHandler } from '../src/feishu/event-handler.js';
import type { BotConfig } from '../src/config.js';
import { MessageBridge } from '../src/bridge/message-bridge.js';

const config = { enabled: true, approvalCode: 'expense', financeNodeIds: ['finance'], sessionTtlSeconds: 900 };
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
function detail(id = 'one', status = 'APPROVED', amount = '0.30'): ApprovalDetail {
  return {
    instance_code: id,
    approval_code: 'expense',
    open_id: 'alice',
    start_time: '100',
    serial_number: id,
    status,
    task_list: [{ status: 'PENDING', node_id: 'finance' }],
    form: JSON.stringify([
      { name: '报销月份', value: '2026-11-01T00:00:00+08:00' },
      { name: '报销抬头', value: '合成公司' },
      {
        name: '费用明细',
        value: ['0.10', '0.20'].map((value, i) => [
          { name: '费用日期', value: `2026-11-0${i + 1}` },
          { name: '项目编号', value: 'P-DEMO' },
          { name: '费用类型', value: '测试' },
          { name: '说明', value: '合成数据' },
          { name: '金额', value, ext: { currency: 'CNY' } },
        ]),
      },
      { name: '费用汇总', value: amount, ext: { currency: 'CNY' } },
    ]),
  };
}
function buttons(card: any): any[] {
  if (!card || typeof card !== 'object') return [];
  return [
    ...(card.tag === 'button' ? [card] : []),
    ...Object.values(card).flatMap((value) => (Array.isArray(value) ? value.flatMap(buttons) : buttons(value))),
  ];
}
function harness(records = [detail()]) {
  let time = 0;
  const approvals = {
    latest: vi.fn(async () => ({ records, financeReady: true })),
    detail: vi.fn(async () => records[0]),
    name: vi.fn(async () => '示例员工'),
    financeReady: vi.fn(async () => true),
  };
  const sender = {
    sendText: vi.fn(async () => 'text'),
    sendCard: vi.fn(async (_chat: string, _content: string) => 'card'),
    updateCard: vi.fn(async (_messageId: string, _content: string) => true),
    uploadFile: vi.fn(async () => 'file'),
    sendFile: vi.fn(async () => ({ messageId: 'sent' })),
  };
  const cleanup = vi.fn(async () => {});
  const render = vi.fn(async () => ({ filePath: '/tmp/test.pdf', cleanup }));
  const service = new ReimbursementPrintService(config, approvals, sender, render, logger, () => time);
  const msg = {
    chatId: 'dm',
    chatType: 'p2p',
    tenantKey: 'tenant',
    userId: 'alice',
    messageId: 'request',
    text: '获取报销单',
  };
  const selection = () => {
    const card = JSON.parse(
      sender.updateCard.mock.calls.find((c) => JSON.parse(c[1]).header.title.content === '报销打印｜选择单据')![1],
    );
    const value = buttons(card)[0].behaviors[0].value;
    return { chatId: 'dm', tenantKey: 'tenant', userId: 'alice', messageId: 'card', value };
  };
  return {
    approvals,
    sender,
    cleanup,
    render,
    service,
    msg,
    selection,
    advance: (n: number) => {
      time += n;
    },
  };
}

describe('exact amounts, schema and state', () => {
  it('uses cents, including zero, and validates totals', () => {
    expect(moneyText(moneyCents('0.10') + moneyCents('0.20'))).toBe('0.30');
    expect(moneyText(moneyCents('0'))).toBe('0.00');
    expect(moneyText(moneyCents('-1.23'))).toBe('-1.23');
    expect(extractPrintData(detail(), '示例员工').total).toBe('0.30');
    expect(() => extractPrintData(detail('bad', 'APPROVED', '0.31'), '示例员工')).toThrow();
    for (const value of ['', undefined, 'NaN', '1e3', '0.001']) expect(() => moneyCents(value)).toThrow();
  });
  it('permits only approved or explicitly configured active finance tasks', () => {
    expect(printable(detail(), [])).toBe(true);
    expect(printable(detail('p', 'PENDING'), ['finance'])).toBe(true);
    expect(printable(detail('p', 'PENDING'), [])).toBe(false);
    for (const status of ['CANCELED', 'REJECTED', 'DELETED', 'DRAFT'])
      expect(printable(detail('x', status), ['finance'])).toBe(false);
    const parallel = detail('p', 'PENDING');
    parallel.task_list.push({ status: 'PENDING', node_id: 'manager' });
    expect(printable(parallel, ['finance'])).toBe(false);
    expect(() => assertOwner(detail(), 'bob', 'expense')).toThrow();
    expect(() => assertOwner(detail(), 'alice', 'other')).toThrow();
  });
  it('rejects mixed currency, absent fields, and unsupported beneficiary fields', () => {
    const d = detail();
    const form = JSON.parse(d.form);
    form[2].value[0][4].ext.currency = 'USD';
    d.form = JSON.stringify(form);
    expect(() => extractPrintData(d, '示例员工')).toThrow();
    form[2].value[0][4].ext.currency = 'CNY';
    form.push({ name: '申请人', value: '另一个人' });
    d.form = JSON.stringify(form);
    expect(() => extractPrintData(d, '示例员工')).toThrow();
    expect(() => extractPrintData({ ...d, form: '[]' }, '示例员工')).toThrow();
  });
});

describe('approval SDK adapter', () => {
  it('scans later API pages, deduplicates, filters then sorts latest five', async () => {
    const ds = Array.from({ length: 7 }, (_, i) => ({ ...detail(`id${i}`), start_time: String(100 + i) }));
    const request = vi.fn(async (req: any) => {
      if (req.url.includes('/approvals/')) return { code: 0, data: { node_list: [{ node_id: 'finance' }] } };
      if (req.url.endsWith('/query')) {
        expect(req.params.page_size).toBe(100);
        expect(req.data.user_id).toBe('alice');
        expect(req.data.page_size).toBeUndefined();
        return {
          code: 0,
          data: req.params.page_token
            ? { instance_list: ds.map((d) => ({ instance: { code: d.instance_code } })), has_more: false }
            : { instance_list: [{ instance: { code: 'withdrawn' } }], has_more: true, page_token: 'next' },
        };
      }
      const id = req.url.split('/').pop();
      return { code: 0, data: id === 'withdrawn' ? detail(id, 'CANCELED') : ds.find((d) => d.instance_code === id) };
    });
    const api = new ApprovalClient({ request } as unknown as lark.Client, 'expense', ['finance']);
    const result = await api.latest('alice');
    expect(result.records.map((d) => d.instance_code)).toEqual(['id6', 'id5', 'id4', 'id3', 'id2']);
    expect(result.financeReady).toBe(true);
  });
  it('fails closed for repeated pagination token, foreign ownership and missing permissions', async () => {
    const request = vi.fn(async (req: any) => {
      if (req.url.includes('/approvals/')) return { code: 0, data: { node_list: [] } };
      return { code: 0, data: { instance_list: [], has_more: true, page_token: 'repeat' } };
    });
    const api = new ApprovalClient({ request } as unknown as lark.Client, 'expense', ['finance']);
    await expect(api.latest('alice')).rejects.toThrow();
    request.mockImplementation(async () => ({ code: 0, data: detail() }) as any);
    await expect(api.detail('one', 'bob')).rejects.toThrow();
    request.mockImplementation(async () => ({ code: 99991672 }) as any);
    await expect(api.latest('alice')).rejects.toMatchObject({ category: 'permission' });
  });
});

describe('private selection and print workflow', () => {
  it('renders actual count with opaque callback IDs and no pagination', async () => {
    const h = harness([detail('1'), detail('2')]);
    await h.service.handleMessage(h.msg);
    const card = JSON.parse(
      h.sender.updateCard.mock.calls.find((c) => JSON.parse(c[1]).header.title.content === '报销打印｜选择单据')![1],
    );
    expect(buttons(card)).toHaveLength(2);
    expect(card.header.title.content).toBe('报销打印｜选择单据');
    expect(card.header.template).toBe('green');
    const thinking = JSON.parse(h.sender.sendCard.mock.calls[0][1]);
    expect(thinking.header.template).toBe('blue');
    expect(thinking.header.title.content).toContain('Thinking');
    expect(h.sender.updateCard.mock.calls[0][0]).toBe('card');
    const panel = card.body.elements.find((e: any) => e.tag === 'column_set').columns[0];
    expect(panel.background_style).toBe('grey-50');
    expect(panel.elements[0].columns.map((c: any) => c.weight)).toEqual([3, 1]);
    expect(panel.elements[0].columns[0].elements[0].content).toBe('**1　¥0.30**');
    expect(panel.elements[0].columns[0].elements[1].content).toContain('11月01日 · 合成公司 · 已通过');
    expect(buttons(card).map((b) => b.type)).toEqual(['primary_filled', 'default']);
    expect(h.selection().value).toEqual({
      action: 'reimbursement_print.select',
      session: expect.any(String),
      option: expect.any(String),
    });
    expect(JSON.stringify(card)).not.toContain('查看更早');
    expect(JSON.stringify(h.selection().value)).not.toContain('alice');
  });
  it('handles zero results, other text and groups without querying private data', async () => {
    const h = harness([]);
    await h.service.handleMessage({ ...h.msg, chatType: 'group' });
    await h.service.handleMessage({ ...h.msg, text: '你好' });
    expect(h.approvals.latest).not.toHaveBeenCalled();
    await h.service.handleMessage(h.msg);
    expect(h.sender.sendCard).toHaveBeenCalledTimes(2);
    const usage = JSON.parse(h.sender.sendCard.mock.calls[0][1]);
    expect(usage.header.template).toBe('red');
    expect(usage.header.title.content).toContain('使用提示');
    expect(JSON.stringify(usage)).toContain('获取报销单');
    const completed = JSON.parse(h.sender.updateCard.mock.calls.at(-1)![1]);
    expect(completed.header.template).toBe('green');
    expect(JSON.stringify(completed)).toContain('暂无');
  });
  it.each(['userId', 'tenantKey', 'chatId', 'messageId', 'option', 'session'])('rejects forged %s', async (field) => {
    const h = harness();
    await h.service.handleMessage(h.msg);
    const event = h.selection();
    if (field === 'option' || field === 'session') event.value[field] = 'forged';
    else (event as any)[field] = 'forged';
    await h.service.handleCardAction(event);
    expect(h.render).not.toHaveBeenCalled();
  });
  it('rejects expired/restarted/cross-bot sessions without generating a PDF', async () => {
    const h = harness();
    await h.service.handleMessage(h.msg);
    const e = h.selection();
    h.advance(900_001);
    await h.service.handleCardAction(e);
    await harness().service.handleCardAction(e);
    expect(h.render).not.toHaveBeenCalled();
    expect(h.sender.sendText.mock.calls.at(-1)?.[1]).toMatch(/失效|过期/);
  });
  it('revalidates ownership and current status before rendering', async () => {
    for (const changed of [{ ...detail(), open_id: 'bob' }, detail('one', 'CANCELED'), detail('one', 'PENDING')]) {
      const h = harness();
      await h.service.handleMessage(h.msg);
      h.approvals.detail.mockResolvedValue(changed);
      h.approvals.financeReady.mockResolvedValue(false);
      await h.service.handleCardAction(h.selection());
      expect(h.render).not.toHaveBeenCalled();
    }
  });
  it('deduplicates double click and cleans up after one successful send', async () => {
    const h = harness();
    await h.service.handleMessage(h.msg);
    await Promise.all([h.service.handleCardAction(h.selection()), h.service.handleCardAction(h.selection())]);
    expect(h.render).toHaveBeenCalledTimes(1);
    expect(h.sender.sendFile).toHaveBeenCalledTimes(1);
    expect(h.cleanup).toHaveBeenCalledTimes(1);
  });
  it.each(['pdf', 'upload', 'send'])('reports %s failure and never retries the same selection', async (stage) => {
    const h = harness();
    await h.service.handleMessage(h.msg);
    if (stage === 'pdf') h.render.mockRejectedValue(new Error('private internal detail'));
    if (stage === 'upload') h.sender.uploadFile.mockResolvedValue(undefined as any);
    if (stage === 'send') h.sender.sendFile.mockResolvedValue(false as any);
    await h.service.handleCardAction(h.selection());
    await h.service.handleCardAction(h.selection());
    expect(h.render).toHaveBeenCalledTimes(1);
    if (stage !== 'pdf') expect(h.cleanup).toHaveBeenCalledTimes(1);
    const failure = JSON.parse(h.sender.updateCard.mock.calls.at(-1)![1]);
    expect(failure.header.template).toBe('red');
    expect(JSON.stringify(failure)).toMatch(/失败|未确认|遇到问题/);
    expect(JSON.stringify(failure)).not.toContain('private internal detail');
  });
});

describe('model-free routing', () => {
  it('uses original platform chat type and text without context expansion', async () => {
    const onMessage = vi.fn();
    const botConfig = {
      name: 'print',
      feishu: { appId: 'print' },
      reimbursementPrint: config,
      groupOnly: true,
      privateRequireMention: true,
    } as BotConfig;
    const sender = { listMessages: vi.fn(), getChatMemberCount: vi.fn() } as any;
    const receive = createReceiveHandler(botConfig, logger, onMessage, 'bot', sender);
    await receive({
      sender: { sender_id: { open_id: 'alice' }, tenant_key: 'tenant' },
      message: {
        message_id: 'unique-print-event',
        chat_id: 'dm',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: '获取报销单' }),
      },
    });
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: '获取报销单', chatType: 'p2p', tenantKey: 'tenant' }),
    );
    expect(sender.listMessages).not.toHaveBeenCalled();
  });
  it('routes messages and callbacks before model/pending-question paths', async () => {
    // A prototype harness proves no constructor/executor is needed by this route.
    const bridge = Object.create(MessageBridge.prototype) as any;
    bridge.config = { reimbursementPrint: config };
    bridge.deps = { businessHandler: { handleMessage: vi.fn(), handleCardAction: vi.fn() } };
    bridge.executeQuery = vi.fn();
    bridge.executorForEngine = vi.fn();
    for (const text of ['获取报销单', '普通文字', '/unknown', '/goal start'])
      await bridge.handleMessage({ chatId: 'dm', chatType: 'p2p', text });
    await bridge.handleCardAction({ value: { action: 'reimbursement_print.select' } });
    expect(bridge.deps.businessHandler.handleMessage).toHaveBeenCalledTimes(4);
    expect(bridge.deps.businessHandler.handleCardAction).toHaveBeenCalledTimes(1);
    expect(await bridge.executeApiTask({ chatId: 'dm', prompt: 'run model' })).toMatchObject({ success: false });
    expect(bridge.executeQuery).not.toHaveBeenCalled();
    expect(bridge.executorForEngine).not.toHaveBeenCalled();
  });
  it('preserves system management command precedence and fails closed without the module', async () => {
    const bridge = Object.create(MessageBridge.prototype) as any;
    bridge.config = { reimbursementPrint: config };
    bridge.commandHandler = { handle: vi.fn() };
    bridge.sender = { sendText: vi.fn() };
    for (const text of ['/stop', '/reset', '/status', 'reset'])
      await bridge.handleMessage({ chatId: 'dm', chatType: 'p2p', text });
    expect(bridge.commandHandler.handle).toHaveBeenCalledTimes(4);
    await bridge.handleMessage({ chatId: 'dm', chatType: 'p2p', text: '获取报销单' });
    expect(bridge.sender.sendText).toHaveBeenCalled();
  });
});

describe('selection card text safety', () => {
  it('escapes form text while preserving layout and exact currency formatting', () => {
    const card = JSON.parse(
      buildSelectionCard(
        [
          {
            serial: '**unsafe**',
            amount: '1234567.89',
            date: '2026-11-06',
            title: '<at id=all>所有人</at>',
            status: '已通过',
            value: { action: 'reimbursement_print.select', session: 'opaque', option: 'opaque' },
          },
        ],
        900,
        '',
      ),
    );
    const text = JSON.stringify(card);
    expect(text).toContain('¥1,234,567.89');
    expect(text).not.toContain('<at');
    expect(text).toContain('&lt;at');
    expect(buttons(card)).toHaveLength(1);
  });
});

describe('query status card lifecycle', () => {
  it('falls back to a new green card if replacing the thinking card fails, and binds that card', async () => {
    const h = harness();
    h.sender.sendCard.mockResolvedValueOnce('thinking').mockResolvedValueOnce('selection');
    h.sender.updateCard.mockResolvedValueOnce(false);
    await h.service.handleMessage(h.msg);
    const card = JSON.parse(h.sender.sendCard.mock.calls[1][1]);
    expect(card.header.template).toBe('green');
    const event = { ...h.selection(), messageId: 'selection', value: buttons(card)[0].behaviors[0].value };
    expect(h.service.validateCardAction({ ...event, messageId: 'thinking' })).toBeTruthy();
    expect(h.service.validateCardAction(event)).toBeUndefined();
  });
  it('turns a query failure into a red card instead of leaving Thinking visible', async () => {
    const h = harness();
    h.approvals.latest.mockRejectedValue(new Error('internal'));
    await h.service.handleMessage(h.msg);
    const card = JSON.parse(h.sender.updateCard.mock.calls.at(-1)![1]);
    expect(card.header.template).toBe('red');
    expect(JSON.stringify(card)).not.toContain('internal');
    expect(h.render).not.toHaveBeenCalled();
  });
});
