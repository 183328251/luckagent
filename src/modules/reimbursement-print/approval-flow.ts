import type { ApprovalDetail, PrintApprovalRow } from './types.js';

const eventLabels = new Map([
  ['START', '发起申请'],
  ['PASS', '同意'],
  ['REJECT', '拒绝'],
  ['AUTO_PASS', '自动通过'],
  ['AUTO_REJECT', '自动拒绝'],
  ['REMOVE_REPEAT', '去重跳过'],
  ['TRANSFER', '转交'],
  ['ADD_APPROVER_BEFORE', '前加签'],
  ['ADD_APPROVER', '加签'],
  ['ADD_APPROVER_AFTER', '后加签'],
  ['DELETE_APPROVER', '移除审批人'],
  ['ROLLBACK_SELECTED', '退回指定节点'],
  ['ROLLBACK', '退回'],
  ['CANCEL', '撤回'],
  ['DELETE', '删除'],
  ['CC', '抄送'],
]);
const taskLabels = new Map([
  ['PENDING', '待审批'],
  ['APPROVED', '同意'],
  ['REJECTED', '拒绝'],
  ['TRANSFERRED', '已转交'],
  ['DONE', '已结束'],
]);
const eventTaskStatuses = new Map([
  ['PASS', 'APPROVED'],
  ['AUTO_PASS', 'APPROVED'],
  ['REJECT', 'REJECTED'],
  ['AUTO_REJECT', 'REJECTED'],
  ['TRANSFER', 'TRANSFERRED'],
  ['REMOVE_REPEAT', 'DONE'],
]);
const timeFormatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  dateStyle: 'short',
  timeStyle: 'short',
});

function timestamp(value?: string): number | undefined {
  const milliseconds = Number(value);
  return milliseconds > 0 && Number.isSafeInteger(milliseconds) && milliseconds <= 8.64e15
    ? milliseconds
    : undefined;
}

export async function extractApprovalFlow(
  detail: ApprovalDetail,
  applicantName: string,
  lookupName: (openId: string) => Promise<string>,
): Promise<PrintApprovalRow[]> {
  const tasks = detail.task_list ?? [];
  const tasksById = new Map(tasks.filter((task) => task.id).map((task) => [task.id, task]));
  const nodeNames = new Map(
    tasks.filter((task) => task.node_id && task.node_name).map((task) => [task.node_id, task.node_name]),
  );
  const events = detail.timeline ?? [];
  const recordedTasks = new Set<string>();
  const entries = events.map((event) => {
    const task = event.task_id ? tasksById.get(event.task_id) : undefined;
    if (event.task_id && task && eventTaskStatuses.get(event.type) === task.status)
      recordedTasks.add(event.task_id);
    const isStart = event.type === 'START';
    const automatic = event.type.startsWith('AUTO_') || event.type === 'REMOVE_REPEAT';
    return {
      node: isStart ? '发起申请' : task?.node_name || nodeNames.get(event.node_key) || '—',
      openId: isStart ? detail.open_id : event.open_id || task?.open_id,
      automatic,
      action: eventLabels.get(event.type) || '流程更新',
      time: timestamp(event.create_time),
      comment: event.comment?.replace(/\r\n?/g, '\n').trim() || '—',
    };
  });
  if (!events.some((event) => event.type === 'START')) {
    entries.unshift({
      node: '发起申请',
      openId: detail.open_id,
      automatic: false,
      action: '发起申请',
      time: timestamp(detail.start_time),
      comment: '—',
    });
  }
  for (const task of tasks) {
    if (task.id && recordedTasks.has(task.id)) continue;
    const automatic = task.status !== 'PENDING' && (task.type === 'AUTO_PASS' || task.type === 'AUTO_REJECT');
    entries.push({
      node: task.node_name || '—',
      openId: task.open_id,
      automatic,
      action: (automatic && task.type && eventLabels.get(task.type)) || taskLabels.get(task.status) || '流程更新',
      time: timestamp(task.end_time) ?? timestamp(task.start_time),
      comment: '—',
    });
  }
  entries.sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity));
  const names = new Map([[detail.open_id, applicantName]]);
  const rows: PrintApprovalRow[] = [];
  for (const { openId, automatic, time, ...entry } of entries) {
    let person = automatic ? '系统' : '—';
    if (!automatic && openId) {
      if (!names.has(openId)) {
        names.set(openId, await lookupName(openId).catch(() => '姓名不可用'));
      }
      person = names.get(openId) || '姓名不可用';
    }
    rows.push({ ...entry, person, time: time === undefined ? '—' : timeFormatter.format(time) });
  }
  return rows;
}
