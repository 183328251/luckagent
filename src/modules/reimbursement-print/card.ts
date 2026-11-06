import { buildCardV2 } from '../../feishu/card-builder-v2.js';

/** Layout follows tiger's approved Card 2.0 mockup; values remain server-bound. */
export interface SelectionCardItem {
  serial: string;
  amount: string;
  date: string;
  title: string;
  status: string;
  value: { action: string; session: string; option: string };
}
function escapeMarkdown(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_[\]()#!|]/g, '\\$&')
    .replace(/[\r\n]+/g, ' ');
}
export function buildSelectionCard(items: SelectionCardItem[], ttlSeconds: number, notice: string): string {
  const rows = items.map((item, i) => {
    const amount = item.amount.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const date = `${item.date.slice(5, 7)}月${item.date.slice(8, 10)}日`;
    return {
      tag: 'column_set',
      flex_mode: 'none',
      horizontal_spacing: '12px',
      columns: [
        {
          tag: 'column',
          width: 'weighted',
          weight: 3,
          vertical_spacing: '4px',
          padding: '8px',
          elements: [
            { tag: 'markdown', content: `**${escapeMarkdown(item.serial)}\u3000¥${escapeMarkdown(amount)}**` },
            {
              tag: 'markdown',
              content: `<font color='grey'>${[date, item.title, item.status].map(escapeMarkdown).join(' · ')}</font>`,
            },
          ],
        },
        {
          tag: 'column',
          width: 'weighted',
          weight: 1,
          vertical_align: 'center',
          padding: '8px',
          elements: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '打印这笔' },
              type: i === 0 ? 'primary_filled' : 'default',
              behaviors: [{ type: 'callback', value: item.value }],
            },
          ],
        },
      ],
    };
  });
  return JSON.stringify({
    schema: '2.0',
    config: { width_mode: 'default', enable_forward: false },
    header: { title: { tag: 'plain_text', content: '报销打印｜选择单据' }, template: 'green' },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [
        { tag: 'markdown', content: '**请选择一笔报销，生成 PDF 后自行打印**' },
        ...(notice ? [{ tag: 'div', text: { tag: 'plain_text', content: notice.trim() } }] : []),
        {
          tag: 'column_set',
          flex_mode: 'none',
          columns: [
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              background_style: 'grey-50',
              vertical_spacing: '8px',
              elements: rows,
            },
          ],
        },
        {
          tag: 'markdown',
          content: `<font color='grey'>仅展示本人最新5笔符合条件的报销，不足5笔按实际数量显示。选单有效期 ${ttlSeconds / 60} 分钟；如需刷新或补打，请重新发送“获取报销单”。</font>`,
        },
      ],
    },
  });
}

/** Reuse ordinary bot status cards; this visual state never calls a model. */
export function buildProgressCard(status: 'thinking' | 'complete' | 'error', content: string, title?: string): string {
  const card = JSON.parse(buildCardV2({ status, userPrompt: '', responseText: content, toolCalls: [] }));
  card.config.enable_forward = false;
  if (title) card.header.title.content = title;
  return JSON.stringify(card);
}
