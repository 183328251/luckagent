import type * as lark from '@larksuiteoapi/node-sdk';
import { PrintError, type ApprovalDetail } from './types.js';
import { assertOwner, printable } from './data.js';

export interface ApprovalReader {
  financeReady(): Promise<boolean>;
  latest(userId: string): Promise<{ records: ApprovalDetail[]; financeReady: boolean }>;
  detail(instanceId: string, userId: string): Promise<ApprovalDetail>;
  name(userId: string): Promise<string>;
}
/** Uses the same app client/token cache as the bot; never borrows tiger identity. */
export class ApprovalClient implements ApprovalReader {
  constructor(
    private client: lark.Client,
    private code: string,
    private financeNodes: string[],
  ) {}

  private async request<T>(method: string, url: string, params?: object, data?: object): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      let response;
      try {
        response = await this.client.request({ method, url, params, data, timeout: 20_000 });
      } catch {
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
          continue;
        }
        throw new PrintError('审批查询暂时失败，请稍后重试。', 'api_failed');
      }
      const result = response as { code?: number; data?: T };
      if (result.code === 0 && result.data) return result.data;
      if ([99991672, 99991679, 99991671, 99991668, 60011, 60012].includes(result.code || 0)) {
        throw new PrintError('打印助手暂无读取审批或人员信息的权限，请联系管理员。', 'permission');
      }
      if ([99991400, 99991401, 1395001].includes(result.code || 0) && attempt < 2) {
        await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
        continue;
      }
      throw new PrintError('审批查询失败，请稍后重试；如持续失败，请联系管理员检查权限。', 'api_failed');
    }
    throw new PrintError('审批查询暂时失败，请稍后重试。', 'api_failed');
  }

  async detail(id: string, userId: string): Promise<ApprovalDetail> {
    const detail = await this.request<ApprovalDetail>(
      'GET',
      `/open-apis/approval/v4/instances/${encodeURIComponent(id)}`,
      { user_id_type: 'open_id', locale: 'zh-CN' },
    );
    assertOwner(detail, userId, this.code);
    return { ...detail, instance_code: id };
  }

  async financeReady(): Promise<boolean> {
    // Recheck the definition on every list. A changed/removed node never opens
    // all PENDING records. APPROVED remains available with a visible notice.
    const definition = await this.request<{ node_list: { node_id: string }[] }>(
      'GET',
      `/open-apis/approval/v4/approvals/${encodeURIComponent(this.code)}`,
      { locale: 'zh-CN' },
    );
    return (
      this.financeNodes.length > 0 &&
      this.financeNodes.every((id) => definition.node_list.some((n) => n.node_id === id))
    );
  }

  async latest(userId: string): Promise<{ records: ApprovalDetail[]; financeReady: boolean }> {
    const financeReady = await this.financeReady();
    const nodes = financeReady ? this.financeNodes : [];
    let token: string | undefined;
    const seen = new Set<string>();
    const ids = new Set<string>();
    do {
      const page: {
        instance_list?: { approval?: { code?: string }; instance?: { code?: string } }[];
        has_more?: boolean;
        page_token?: string;
      } = await this.request(
        'POST',
        '/open-apis/approval/v4/instances/query',
        { user_id_type: 'open_id', page_size: 100, ...(token ? { page_token: token } : {}) },
        // Both time boundaries intentionally omitted: all available history,
        // without assuming page order or imposing a hidden lookback window.
        { user_id: userId, approval_code: this.code, locale: 'zh-CN' },
      );
      for (const item of page.instance_list || []) {
        if (item.approval?.code && item.approval.code !== this.code)
          throw new PrintError('审批类型校验失败，请联系管理员。', 'approval_mismatch');
        if (!item.instance?.code) throw new PrintError('审批查询返回数据不完整，请稍后重试。', 'invalid_list');
        ids.add(item.instance.code);
      }
      if (!page.has_more) break;
      token = page.page_token;
      if (!token || seen.has(token) || seen.size >= 1000)
        throw new PrintError('审批查询未能完整完成，请稍后重试。', 'pagination');
      seen.add(token);
    } while (token);
    const records: ApprovalDetail[] = [];
    // Sequential details avoid bursting the approval API rate limit.
    for (const id of ids) {
      const d = await this.detail(id, userId);
      if (!/^\d+$/.test(d.start_time || '') || !Number.isSafeInteger(Number(d.start_time)))
        throw new PrintError('审批时间数据不完整，请联系管理员。', 'invalid_time');
      if (printable(d, nodes)) records.push(d);
    }
    records.sort(
      (a, b) =>
        Number(b.start_time) - Number(a.start_time) ||
        (a.instance_code! < b.instance_code! ? -1 : a.instance_code === b.instance_code ? 0 : 1),
    );
    return { records: records.slice(0, 5), financeReady };
  }

  async name(userId: string): Promise<string> {
    const data = await this.request<{ user: { open_id?: string; name?: string } }>(
      'GET',
      `/open-apis/contact/v3/users/${encodeURIComponent(userId)}`,
      { user_id_type: 'open_id' },
    );
    if (data.user?.open_id !== userId || !data.user.name)
      throw new PrintError('暂时无法核实申请人姓名，请联系管理员检查通讯录权限。', 'name');
    return data.user.name;
  }
}
