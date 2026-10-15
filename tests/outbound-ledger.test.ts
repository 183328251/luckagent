import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { OutboundLedger } from '../src/bridge/outbound-ledger.js';

/**
 * [design-note P] 出站台账。锁三条契约：
 *   1. record/get/updateText 绝不抛（台账坏了只降级引用解析，不碍发送主链路）；
 *   2. 同 messageId 覆盖写（INSERT OR REPLACE）、updateText 缺行无操作——
 *      流式卡片「终版内容赢」依赖这两条；
 *   3. 30 天 TTL 清理只删旧行。
 */

const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;

describe('OutboundLedger', () => {
  let tmpDir: string;
  let ledger: OutboundLedger;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luckagent-ledger-'));
    ledger = new OutboundLedger(mockLogger, { dbPath: path.join(tmpDir, 'ledger.db') });
  });

  afterEach(() => {
    ledger.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('records and reads back a full media row', () => {
    ledger.record({
      messageId: 'om_1', botName: 'botA', chatId: 'oc_1', kind: 'image',
      filePath: '/tmp/a.png', fileName: 'a.png', mediaKey: 'img_v3_x',
    });
    expect(ledger.get('om_1')).toMatchObject({
      messageId: 'om_1', botName: 'botA', chatId: 'oc_1', kind: 'image',
      filePath: '/tmp/a.png', fileName: 'a.png', mediaKey: 'img_v3_x',
    });
  });

  it('records file size + work dir, and migrates a DB created before those columns existed', async () => {
    ledger.close();
    const dbPath = path.join(tmpDir, 'old.db');
    const { default: Database } = await import('better-sqlite3');
    const old = new Database(dbPath);
    old.exec(`CREATE TABLE outbound_messages (message_id TEXT PRIMARY KEY, bot_name TEXT NOT NULL, chat_id TEXT NOT NULL,
      kind TEXT NOT NULL, text TEXT, file_path TEXT, file_name TEXT, media_key TEXT, ts INTEGER NOT NULL)`);
    old.prepare(`INSERT INTO outbound_messages VALUES ('om_old','botA','oc_1','file',NULL,'/tmp/x','x.pdf','file_k',?)`).run(Date.now());
    old.close();
    ledger = new OutboundLedger(mockLogger, { dbPath });
    expect(ledger.get('om_old')).toMatchObject({ fileName: 'x.pdf', fileSize: undefined, workDir: undefined });
    ledger.record({ messageId: 'om_new', botName: 'botA', chatId: 'oc_1', kind: 'file', fileName: 'y.pptx', mediaKey: 'k', fileSize: 42, workDir: '/w' });
    expect(ledger.get('om_new')).toMatchObject({ fileSize: 42, workDir: '/w' });
  });

  it('get on a missing id returns undefined', () => {
    expect(ledger.get('om_missing')).toBeUndefined();
  });

  it('same messageId overwrites (INSERT OR REPLACE)', () => {
    ledger.record({ messageId: 'om_1', botName: 'botA', chatId: 'oc_1', kind: 'text', text: 'v1' });
    ledger.record({ messageId: 'om_1', botName: 'botA', chatId: 'oc_1', kind: 'text', text: 'v2' });
    expect(ledger.get('om_1')?.text).toBe('v2');
  });

  it('updateText updates an existing row and no-ops on a missing one', () => {
    ledger.record({ messageId: 'om_card', botName: 'botA', chatId: 'oc_1', kind: 'card', text: 'thinking…' });
    ledger.updateText('om_card', 'final answer');
    expect(ledger.get('om_card')?.text).toBe('final answer');
    expect(() => ledger.updateText('om_missing', 'x')).not.toThrow();
    expect(ledger.get('om_missing')).toBeUndefined();
  });

  it('truncates text at 4000 chars on both record and updateText', () => {
    const long = 'x'.repeat(5000);
    ledger.record({ messageId: 'om_1', botName: 'b', chatId: 'c', kind: 'card', text: long });
    expect(ledger.get('om_1')?.text).toHaveLength(4000);
    ledger.updateText('om_1', long);
    expect(ledger.get('om_1')?.text).toHaveLength(4000);
  });

  it('cleanup prunes rows older than 30 days and keeps fresh ones', () => {
    const now = Date.now();
    ledger.record({ messageId: 'om_old', botName: 'b', chatId: 'c', kind: 'text', text: 'old', ts: now - 31 * 24 * 60 * 60 * 1000 });
    ledger.record({ messageId: 'om_new', botName: 'b', chatId: 'c', kind: 'text', text: 'new', ts: now });
    ledger.cleanup();
    expect(ledger.get('om_old')).toBeUndefined();
    expect(ledger.get('om_new')).toBeDefined();
  });

  it('never throws after close (degrades to no-op)', () => {
    ledger.close();
    expect(() => ledger.record({ messageId: 'om_x', botName: 'b', chatId: 'c', kind: 'text', text: 't' })).not.toThrow();
    expect(() => ledger.updateText('om_x', 't')).not.toThrow();
    expect(ledger.get('om_x')).toBeUndefined();
  });

  it('survives an unwritable db path (constructor degrades, ops are no-ops)', () => {
    const broken = new OutboundLedger(mockLogger, { dbPath: path.join(tmpDir, 'no-such-dir', 'x', 'ledger.db') });
    expect(() => broken.record({ messageId: 'om_x', botName: 'b', chatId: 'c', kind: 'text', text: 't' })).not.toThrow();
    expect(broken.get('om_x')).toBeUndefined();
    broken.close();
  });
});
