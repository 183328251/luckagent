import { useEffect, useState } from 'react';
import { Alert, Button, Form, Select, Space, Switch, Tag, Typography } from 'antd';
import { api } from '../api/client';
interface Catalog {
  models: Array<{ id: string; displayName: string; reasoningEfforts: string[] }>;
  modes: Array<{ id: string; name: string }>;
  installed: boolean;
  authenticated: boolean | null;
  version?: string;
  plan?: string;
  warning?: string;
}
export default function AntigravitySettings() {
  const form = Form.useFormInstance();
  const model = Form.useWatch(['antigravity', 'model'], form) as string | undefined;
  const [catalog, setCatalog] = useState<Catalog>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const load = async (refresh = false) => {
    setLoading(true);
    setError('');
    try {
      setCatalog(await api.get<Catalog>(`/admin/api/antigravity/models${refresh ? '?refresh=1' : ''}`));
    } catch {
      setError('Antigravity 检测失败，请重试。');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const options = (catalog?.models ?? []).map((m) => ({ value: m.id, label: m.displayName }));
  if (model && !options.some((m) => m.value === model)) options.unshift({ value: model, label: `${model}（已配置）` });
  return (
    <>
      <Space wrap style={{ marginBottom: 12 }}>
        <Tag color={catalog?.authenticated ? 'green' : 'orange'}>
          {catalog?.authenticated ? '登录已确认' : catalog?.authenticated === false ? '未登录' : '登录待确认'}
          {catalog?.version ? ` · ${catalog.version}` : ''}
        </Tag>
        {catalog?.plan && <Tag>{catalog.plan}</Tag>}
        <Button size="small" loading={loading} onClick={() => void load(true)}>
          刷新模型与登录状态
        </Button>
      </Space>
      {(error || catalog?.warning) && (
        <Alert type="warning" message={error || catalog?.warning} style={{ marginBottom: 12 }} />
      )}
      <Typography.Paragraph type="secondary">
        使用桥接所属用户的本机登录。首次运行 agy
        完成认证。普通任务在常驻会话中执行；需要补充信息或权限时会在聊天中提问。
      </Typography.Paragraph>
      <Form.Item name={['antigravity', 'model']} label="Antigravity 模型">
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          loading={loading}
          placeholder="跟随本机默认"
          options={options}
        />
      </Form.Item>
      <Form.Item
        name={['antigravity', 'reasoningEffort']}
        label="推理强度"
        extra="支持的强度随模型变化，CLI 会验证所选值。"
      >
        <Select
          allowClear
          placeholder="跟随本机默认"
          options={(catalog?.models.find((m) => m.id === model)?.reasoningEfforts.length
            ? catalog.models.find((m) => m.id === model)!.reasoningEfforts
            : ['low', 'medium', 'high', 'xhigh', 'max']
          ).map((value) => ({ value, label: value }))}
        />
      </Form.Item>
      <Form.Item
        name={['antigravity', 'mode']}
        label="执行模式"
        extra="默认自动接受工作区文件修改；命令按 CLI 权限规则处理。"
      >
        <Select
          allowClear
          placeholder="accept-edits"
          options={(catalog?.modes.length
            ? catalog.modes
            : [
                { id: 'default', name: 'Default' },
                { id: 'accept-edits', name: 'Accept edits' },
                { id: 'plan', name: 'Plan' },
              ]
          ).map((m) => ({ value: m.id, label: m.name }))}
        />
      </Form.Item>
      <Form.Item
        name={['antigravity', 'skipPermissions']}
        label="自动批准工具权限"
        valuePropName="checked"
        extra="对可信工作区开启；仍启用 CLI 终端沙箱。"
      >
        <Switch />
      </Form.Item>
    </>
  );
}
