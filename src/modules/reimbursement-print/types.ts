import type { IncomingMessage } from '../../types.js';
import type { CardActionEvent } from '../../feishu/event-handler.js';

export interface ReimbursementPrintConfig {
  enabled: boolean;
  approvalCode: string;
  financeNodeIds?: string[];
  /** Relative to this bot's workspace. */
  templatePath?: string;
  sessionTtlSeconds?: number;
  pythonPath?: string;
  fontPath?: string;
}
export interface BusinessHandler {
  handleMessage(message: IncomingMessage): Promise<void>;
  handleCardAction(event: CardActionEvent): Promise<void>;
}
export interface ApprovalDetail {
  instance_code?: string;
  approval_code?: string;
  open_id: string;
  start_time?: string;
  serial_number: string;
  status: string;
  form: string;
  task_list: { status: string; node_id?: string }[];
}
export interface PrintRow {
  date: string;
  project_code: string;
  expense_type: string;
  description: string;
  amount: string;
}
export interface PrintData {
  month: string;
  applicant_name: string;
  currency: 'CNY';
  rows: PrintRow[];
  total: string;
  title: string;
  date: string;
  fields: Record<string, string>;
}
export class PrintError extends Error {
  constructor(
    public readonly userMessage: string,
    public readonly category: string,
  ) {
    super(category);
  }
}
