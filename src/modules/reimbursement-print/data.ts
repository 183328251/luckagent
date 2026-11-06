import { PrintError, type ApprovalDetail, type PrintData } from './types.js';

type Field = { name: string; value?: unknown; ext?: { currency?: string } };
const invalid = () => new PrintError('报销单字段缺失或格式不受支持，请联系管理员核对。', 'invalid_form');
export function moneyCents(value: unknown): bigint {
  const s = String(value ?? '');
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(s)) throw invalid();
  const negative = s.startsWith('-');
  const [whole, fraction = ''] = s.replace(/^-/, '').split('.');
  const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return negative ? -result : result;
}
export function moneyText(cents: bigint): string {
  const n = cents < 0 ? -cents : cents;
  return `${cents < 0 ? '-' : ''}${n / 100n}.${String(n % 100n).padStart(2, '0')}`;
}
export function printable(detail: ApprovalDetail, nodeIds: string[]): boolean {
  if (detail.status === 'APPROVED') return true;
  if (detail.status !== 'PENDING') return false;
  const active = detail.task_list.filter((t) => t.status === 'PENDING');
  // Parallel branches are deliberately conservative: every active approval
  // task must be at an explicitly configured finance node.
  return active.length > 0 && active.every((t) => !!t.node_id && nodeIds.includes(t.node_id));
}
export function assertOwner(detail: ApprovalDetail, userId: string, approvalCode: string): void {
  if (!userId || detail.open_id !== userId || detail.approval_code !== approvalCode) {
    throw new PrintError('无法核实这张报销单的归属，请重新获取报销单。', 'ownership');
  }
}
function fields(value: unknown): Field[] {
  if (!Array.isArray(value) || !value.every((f) => f && typeof f.name === 'string')) throw invalid();
  if (new Set(value.map((f) => f.name)).size !== value.length) throw invalid();
  return value;
}
function scalar(field: Field | undefined, required = true): string {
  const value = field?.value;
  if ((value === undefined || value === null || value === '') && required) throw invalid();
  if (value !== undefined && value !== null && !['string', 'number'].includes(typeof value)) throw invalid();
  return String(value ?? '');
}
function date(value: string): string {
  const result = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(Date.parse(result))) throw invalid();
  return result;
}
export function extractPrintData(detail: ApprovalDetail, applicantName: string): PrintData {
  let form: Field[];
  try {
    form = fields(JSON.parse(detail.form));
  } catch {
    throw invalid();
  }
  const top = new Map(form.map((f) => [f.name, f]));
  // Do not silently interpret an explicitly different beneficiary as the sender.
  const applicant = top.get('申请人');
  if (applicant && applicant.value && scalar(applicant) !== applicantName) throw invalid();
  const rawMonth = scalar(top.get('报销月份'));
  const month = rawMonth.match(/^(\d{4})[-年](\d{1,2})(?:月|-\d{2}.*)?$/);
  if (!month || +month[2] < 1 || +month[2] > 12 || !applicantName) throw invalid();
  const expense = top.get('费用明细')?.value;
  if (!Array.isArray(expense) || expense.length === 0 || expense.length > 2000) throw invalid();
  let sum = 0n;
  const rows = expense.map((raw) => {
    const row = new Map(fields(raw).map((f) => [f.name, f]));
    const amountField = row.get('金额');
    if ((amountField?.ext?.currency || 'CNY') !== 'CNY') {
      throw new PrintError('暂不支持非人民币或多币种报销单打印。', 'currency');
    }
    const amount = moneyCents(scalar(amountField));
    sum += amount;
    return {
      date: date(scalar(row.get('费用日期'))),
      project_code: scalar(row.get('项目编号')),
      expense_type: scalar(row.get('费用类型')),
      description: scalar(row.get('说明'), false),
      amount: moneyText(amount),
    };
  });
  const summary = top.get('费用汇总');
  if ((summary?.ext?.currency || 'CNY') !== 'CNY')
    throw new PrintError('暂不支持非人民币或多币种报销单打印。', 'currency');
  if (sum !== moneyCents(scalar(summary)))
    throw new PrintError('费用明细合计与审批汇总不一致，已停止打印，请联系管理员核对。', 'total_mismatch');
  const extra: Record<string, string> = {};
  for (const f of form) {
    if (typeof f.value === 'string' || typeof f.value === 'number') extra[f.name] = String(f.value);
  }
  return {
    month: `${month[1]}年${month[2].padStart(2, '0')}月`,
    applicant_name: applicantName,
    currency: 'CNY',
    rows,
    total: moneyText(sum),
    title: scalar(top.get('报销抬头'), false) || '报销单',
    date: rows[0].date,
    fields: extra,
  };
}
