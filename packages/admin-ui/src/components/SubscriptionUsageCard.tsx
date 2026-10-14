import { useRef, useState } from 'react';
import { Alert, Button, Card, Col, Empty, Progress, Row, Space, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { api } from '../api/client';
import { usePoll } from '../hooks/usePoll';

interface Window {
  usedPercent: number;
  remainingPercent: number;
  durationMinutes: number | null;
  resetsAt: string | null;
}
interface Usage {
  checkedAt: string | null;
  stale: boolean;
  warning?: string;
  resetCredits: number | null;
  buckets: Array<{ id: string; name: string; plan: string | null; primary: Window | null; secondary: Window | null }>;
}
const time = (value: string) =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
function QuotaWindow({ value, fallback }: { value: Window | null; fallback: string }) {
  if (!value) return <Typography.Text type="secondary">{fallback}：未提供数据</Typography.Text>;
  const minutes = value.durationMinutes;
  const label =
    minutes === 10080
      ? '每周额度'
      : minutes && minutes % 60 === 0
        ? `${minutes / 60} 小时额度`
        : minutes
          ? `${minutes} 分钟额度`
          : fallback;
  const remaining = Math.round(value.remainingPercent);
  const used = Math.round(value.usedPercent);
  return (
    <div>
      <Typography.Text>
        {label} · 已用 <strong>{used}%</strong> · 剩余 {remaining}%
      </Typography.Text>
      <Progress
        percent={value.usedPercent}
        strokeColor={value.usedPercent >= 90 ? '#ff4d4f' : value.usedPercent >= 75 ? '#faad14' : '#52c41a'}
        status="normal"
        showInfo={false}
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {value.resetsAt ? `${time(value.resetsAt)} 重置` : '重置时间未提供'}
      </Typography.Text>
    </div>
  );
}
export function SubscriptionUsageCard({ engine = 'codex' }: { engine?: 'codex' | 'claude' }) {
  const forceRefresh = useRef(false);
  const {
    data: usage,
    error,
    refresh,
  } = usePoll<Usage>(() => api.get(`/admin/api/${engine}/usage${forceRefresh.current ? '?refresh=1' : ''}`), 180000);
  const [loading, setLoading] = useState(false);
  const reload = async () => {
    setLoading(true);
    forceRefresh.current = true;
    try {
      await refresh();
    } finally {
      forceRefresh.current = false;
      setLoading(false);
    }
  };
  return (
    <Card
      title={engine === 'claude' ? 'Claude 订阅额度' : 'GPT 订阅额度'}
      style={{ height: '100%' }}
      size="small"
      loading={!usage && !error}
      extra={
        <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void reload()}>
          刷新
        </Button>
      }
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        {(error || usage?.warning) && <Alert type="warning" showIcon message={error || usage?.warning} />}
        {usage?.buckets.length ? (
          usage.buckets.map((bucket) => (
            <div key={bucket.id}>
              <Space style={{ marginBottom: 10 }}>
                <Typography.Text strong>{bucket.name}</Typography.Text>
                {bucket.plan && <Tag>{bucket.plan.toUpperCase()}</Tag>}
                {usage.stale && <Tag color="orange">上次结果</Tag>}
              </Space>
              <Row gutter={[24, 12]}>
                <Col xs={24} md={12}>
                  <QuotaWindow value={bucket.primary} fallback="短期额度" />
                </Col>
                <Col xs={24} md={12}>
                  <QuotaWindow value={bucket.secondary} fallback="长期额度" />
                </Col>
              </Row>
            </div>
          ))
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无订阅额度数据" />
        )}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          账号共享额度 · {engine === 'codex' && <>免费重置机会：{usage?.resetCredits ?? '未提供'} · </>}
          {usage?.checkedAt ? `查询于 ${time(usage.checkedAt)}` : '尚未查询成功'} · 北京时间
        </Typography.Text>
      </Space>
    </Card>
  );
}
