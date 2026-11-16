import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Radio,
  Space,
  Tag,
  Typography,
  message,
} from 'antd';
import { PlusOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { api } from '../api/client';
import { usePoll } from '../hooks/usePoll';
import type { Overview, BotOverview } from '../api/types';
import { RunStatusTag } from '../components/StatusTag';
import BotFormDrawer from './BotFormDrawer';
import FeishuWizard from './FeishuWizard';
import './BotsPage.css';

export default function BotsPage({ onChanged }: { onChanged: () => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [engineFilter, setEngineFilter] = useState('all');
  const [batchOpen, setBatchOpen] = useState(false);
  const [target, setTarget] = useState('codex');
  const [saving, setSaving] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [testingName, setTestingName] = useState<string | null>(null);

  // Overview merges bots.json entries with the running registry, so bots whose
  // startup failed (bad credentials etc.) still show up here — with a red tag.
  const { data, refresh } = usePoll<Overview>(() => api.get('/admin/api/overview'), 10000);
  const bots = data?.bots || [];

  const testConnection = useCallback(async (name: string) => {
    setTestingName(name);
    try {
      const r = await api.post<{ ok: boolean; msg: string; feishuCode: number | null }>(
        '/admin/api/feishu/test-connection',
        { botName: name },
      );
      if (r.ok) message.success(`「${name}」凭证有效 ✓`);
      else message.error(`「${name}」验证失败：${r.msg}（code ${r.feishuCode ?? 'n/a'}）`);
    } catch (err: any) {
      message.error(err?.message || '测试失败');
    } finally {
      setTestingName(null);
    }
  }, []);

  const removeBot = useCallback(
    async (name: string) => {
      try {
        await api.del(`/api/bots/${encodeURIComponent(name)}`);
        message.success(`已删除「${name}」，重启桥接后生效`);
        onChanged();
        void refresh();
      } catch (err: any) {
        message.error(err?.message || '删除失败');
      }
    },
    [onChanged, refresh],
  );

  const engineOf = (bot: BotOverview) => (bot.running ? bot.engine : bot.configuredEngine || bot.engine);
  const categoryOf = (bot: BotOverview) =>
    bot.modelDisabled ? 'none' : ['claude', 'codex'].includes(engineOf(bot)) ? engineOf(bot) : 'other';
  const searched = bots.filter((b) => `${b.name} ${b.description || ''}`.toLowerCase().includes(search.toLowerCase()));
  const visible = searched.filter((b) => engineFilter === 'all' || categoryOf(b) === engineFilter);
  const engineOptions = [
    { value: 'all', label: '全部' },
    { value: 'claude', label: 'Claude' },
    { value: 'codex', label: 'Codex' },
    { value: 'other', label: '其他' },
    { value: 'none', label: '无模型' },
  ].map((option) => ({
    ...option,
    label: `${option.label} ${option.value === 'all' ? searched.length : searched.filter((b) => categoryOf(b) === option.value).length}`,
  }));
  const eligible = visible.filter((b) => !b.modelDisabled && !!b.configuredEngine);
  const chosen = bots.filter((b) => selected.includes(b.name));
  const changing = chosen.filter((b) => b.configuredEngine !== target);
  useEffect(() => {
    if (data)
      setSelected((previous) =>
        previous.filter((name) => data.bots.some((b) => b.name === name && !b.modelDisabled && !!b.configuredEngine)),
      );
  }, [data]);
  const saveBatch = async () => {
    setSaving(true);
    try {
      const result = await api.post<{ updated: string[]; unchanged: string[] }>('/api/bots/batch-engine', {
        names: selected,
        engine: target,
      });
      message.success(
        `已保存 ${result.updated.length} 个机器人，${result.unchanged.length} 个引擎相同未修改；重启桥接后生效`,
      );
      setBatchOpen(false);
      setSelected([]);
      if (result.updated.length) onChanged();
      void refresh();
    } catch (err: any) {
      message.error(err?.message || '批量设置失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title={`机器人管理 · ${bots.length}`}
      extra={
        <Space>
          <Button icon={<ThunderboltOutlined />} onClick={() => setWizardOpen(true)}>
            飞书接入向导
          </Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setEditing(null);
              setDrawerOpen(true);
            }}
          >
            新建机器人
          </Button>
        </Space>
      }
    >
      <div className="bots-toolbar">
        <Space wrap>
          <Input.Search
            aria-label="搜索机器人"
            placeholder="搜索名称或描述"
            allowClear
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 220 }}
          />
          <Radio.Group
            aria-label="按引擎筛选机器人"
            value={engineFilter}
            onChange={(e) => setEngineFilter(e.target.value)}
            optionType="button"
            buttonStyle="solid"
            options={engineOptions}
          />
        </Space>
        <Space wrap>
          <Checkbox
            disabled={!eligible.length}
            checked={!!eligible.length && eligible.every((b) => selected.includes(b.name))}
            indeterminate={
              eligible.some((b) => selected.includes(b.name)) && !eligible.every((b) => selected.includes(b.name))
            }
            onChange={(e) =>
              setSelected((previous) =>
                e.target.checked
                  ? [...new Set([...previous, ...eligible.map((b) => b.name)])]
                  : previous.filter((name) => !eligible.some((b) => b.name === name)),
              )
            }
          >
            全选当前结果
          </Checkbox>
          <Typography.Text type="secondary">已选 {selected.length} 个</Typography.Text>
          {!!selected.length && (
            <Button type="text" onClick={() => setSelected([])}>
              清空
            </Button>
          )}
          <Button type="primary" disabled={!selected.length} onClick={() => setBatchOpen(true)}>
            批量设置引擎
          </Button>
        </Space>
      </div>
      <div className="bots-grid">
        {visible.map((b) => (
          <Card
            key={b.name}
            size="small"
            className={selected.includes(b.name) ? 'bot-card bot-card-selected' : 'bot-card'}
          >
            <div className="bot-card-heading">
              <Checkbox
                aria-label={`选择机器人${b.name}`}
                disabled={b.modelDisabled || !b.configuredEngine}
                checked={selected.includes(b.name)}
                onChange={(e) =>
                  setSelected((previous) =>
                    e.target.checked ? [...previous, b.name] : previous.filter((name) => name !== b.name),
                  )
                }
              />
              <Typography.Text
                strong
                ellipsis={{ tooltip: b.description?.trim() ? `${b.name}（${b.description.trim()}）` : b.name }}
                style={{ flex: 1, minWidth: 0, fontSize: 16 }}
              >
                {b.name}
                {b.description?.trim() ? `（${b.description.trim()}）` : ''}
              </Typography.Text>
              <RunStatusTag running={b.running} />
            </div>
            <div className="bot-settings">
              {b.modelDisabled ? (
                <Tag>业务机器人 · 无模型</Tag>
              ) : (
                <div className="bot-runtime-row">
                  <span className="bot-runtime-label">运行引擎</span>
                  <Tag
                    color={
                      b.running
                        ? b.engine === 'claude'
                          ? 'orange'
                          : b.engine === 'codex'
                            ? 'blue'
                            : undefined
                        : undefined
                    }
                  >
                    {b.running ? { claude: 'Claude', codex: 'Codex' }[b.engine] || b.engine : '未运行'}
                  </Tag>
                  <Typography.Text type="secondary">{b.connectionName}</Typography.Text>
                  {b.engineSettingsPending && <Tag color="orange">待重启</Tag>}
                  {b.running && (
                    <>
                      <span className="bot-runtime-label">运行模型</span>
                      <Typography.Text
                        className="bot-runtime-model"
                        type={b.model ? undefined : 'secondary'}
                        ellipsis={{ tooltip: b.model || '跟随订阅' }}
                      >
                        {b.model || '跟随订阅'}
                      </Typography.Text>
                    </>
                  )}
                </div>
              )}
            </div>
            <div className="bot-stat">
              <span>
                今日任务 <strong>{b.today.tasks}</strong>
                {!!b.today.failed && <Typography.Text type="danger"> · {b.today.failed} 失败</Typography.Text>}
              </span>
              <span>执行中 {b.executors.active}</span>
            </div>
            <Typography.Paragraph
              type="secondary"
              ellipsis={{ tooltip: b.workDir }}
              style={{ fontSize: 12, marginBottom: 8 }}
            >
              {b.workDir || '未设置工作目录'}
            </Typography.Paragraph>
            <Space wrap>
              <Button
                size="small"
                onClick={() => {
                  setEditing(b.name);
                  setDrawerOpen(true);
                }}
              >
                编辑
              </Button>
              <Button size="small" loading={testingName === b.name} onClick={() => testConnection(b.name)}>
                测试连接
              </Button>
              <Popconfirm
                title={`确认删除「${b.name}」？`}
                description="仅移除配置；工作目录与历史数据不会被删除。"
                onConfirm={() => removeBot(b.name)}
                okText="删除"
                okButtonProps={{ danger: true }}
                cancelText="取消"
              >
                <Button size="small" danger>
                  删除
                </Button>
              </Popconfirm>
            </Space>
          </Card>
        ))}
      </div>
      {!visible.length && <Empty description="没有符合条件的机器人" />}
      <Modal
        title="批量设置引擎"
        open={batchOpen}
        onCancel={() => !saving && setBatchOpen(false)}
        onOk={saveBatch}
        confirmLoading={saving}
        okButtonProps={{ disabled: !changing.length }}
        okText={`保存 ${changing.length} 个变更`}
        cancelText="取消"
        closable={!saving}
        maskClosable={!saving}
      >
        <Radio.Group
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          style={{ margin: '16px 0' }}
          optionType="button"
          options={[
            { label: 'Claude', value: 'claude' },
            { label: 'Codex', value: 'codex' },
          ]}
        />
        <Alert
          type="info"
          showIcon
          message="切换后跟随默认模型"
          description="切换引擎的机器人会清除旧模型及推理强度覆盖；引擎相同的机器人保持原配置。仅保存配置，重启桥接后生效；已有会话与 /model 设置保留。"
        />
        <Typography.Paragraph style={{ marginTop: 16 }}>
          已选 {chosen.length} 个，变更 {changing.length} 个，保持 {chosen.length - changing.length} 个。
        </Typography.Paragraph>
        <div style={{ maxHeight: 240, overflowY: 'auto' }}>
          {chosen.map((b) => (
            <div key={b.name} style={{ padding: '6px 0' }}>
              <strong>{b.name}</strong> · {b.configuredEngine} → {target}
              {b.configuredEngine === target && <Tag style={{ marginLeft: 8 }}>保持原配置</Tag>}
            </div>
          ))}
        </div>
      </Modal>
      <Typography.Paragraph type="secondary" style={{ marginTop: 16 }}>
        提示：新增 / 修改 / 删除机器人都写入 <Typography.Text code>bots.json</Typography.Text>
        ，需要重启桥接进程才会生效（顶栏「重启桥接」按钮）。凭证保存后以掩码显示，编辑时留空即保持不变。
      </Typography.Paragraph>

      <BotFormDrawer
        open={drawerOpen}
        editing={editing}
        onClose={() => setDrawerOpen(false)}
        onSaved={() => {
          onChanged();
          void refresh();
        }}
      />
      <FeishuWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onCreated={() => {
          onChanged();
          void refresh();
        }}
      />
    </Card>
  );
}
