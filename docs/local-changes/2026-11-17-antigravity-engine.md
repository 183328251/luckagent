# Antigravity CLI 引擎

沿用 Codex 的独立引擎适配结构，代码集中在 `src/engines/antigravity/`。没有修改 Claude/Codex 执行器。公共改动限于引擎枚举、工厂、配置解析、模型连接选择、后台表单、会话隔离及桥接生命周期。

## 使用

在桥接所属系统用户下安装 Antigravity CLI，并运行 `agy` 完成登录。本机开发版本为 1.5.10，正式执行需要支持 ACP 的版本。

后台「模型接入」可将全局默认设为 Antigravity，机器人表单可单独选择，也支持批量切换。保存后按现有流程重启。聊天内 `/model antigravity` 切换，`/model <模型 ID>` 覆盖模型，`/model reset` 恢复默认。

机器人表单自动读取账号的模型目录、登录状态、CLI 版本和套餐。支持刷新，不返回账号身份或凭证。额度卡片读取 CLI 原生 `/usage` 的结构化数据，分别展示各模型组的 5 小时和每周额度；查询失败保留旧数据并标记过期。

```json
{
  "name": "example",
  "modelConnection": "antigravity",
  "antigravity": {
    "model": "<后台模型列表中的 ID>",
    "reasoningEffort": "high",
    "mode": "accept-edits",
    "writableRoots": ["/path/to/shared/files"]
  }
}
```

`antigravity.executable` 或 `ANTIGRAVITY_EXECUTABLE_PATH` 指定 CLI 路径。省略模型与强度时使用本机默认。也支持 `engine: "antigravity"` 和 `LUCKAGENT_ENGINE=antigravity` 旧配置入口。模型与强度使用原生会话选择接口，CLI 不支持的值会报错，不静默改用其他模型。

## 会话、权限和问答

正式执行使用每个 bot 独立的常驻 `agy acp --sandbox`，以 JSON-RPC 连接。各聊天使用独立原生 session ID；后续回合复用会话，桥接重启后使用 `session/resume`，旧 CLI 仅支持 load 时改用 `session/load` 并忽略历史重放。`executor.ts` 中的 headless 适配保留供独立调用，不作为正式默认执行路径。

默认 `accept-edits`：工作区修改可自动接受，其他操作遵循 CLI 权限规则。可在后台选择 `default` / `auto` / `plan`；auto 取决于账号能力。需要权限时使用现有问答卡片展示原生 Allow/Deny 选项，只有用户选择对应选项才返回批准；无法匹配的自由文本不会自动批准。

对可信工作区可显式开启 `skipPermissions`，传入 `--dangerously-skip-permissions`，保留终端沙箱。工作目录、inputs、outputs 和额外目录通过原生会话 `additionalDirectories` 授权。共享现有 CLAUDE.md 与 `.claude/skills`，不维护另一份可编辑规则。图片附件作为 ACP image block 传递；交付物沿用 outputs 扫描与回传。

支持 ACP 的 `elicitation/create` 表单，以及旧式 `session/request_permission` 选项问答。原生 oneOf 选项 ID 与自由文本 `*_other` 分开映射，避免把显示标签误传为 ID。前台复用飞书问答卡片，后台任务以通知提问并接收文字回复。问题答复后继续同一回合；停止会取消待答请求和原生回合，取消未响应则重置连接，避免下一轮继承挂起问题。

`/reset` 关闭本聊天的常驻会话。服务退出时关闭 ACP 进程组；断连后正在执行的回合会落成错误结果，后续通过明确 ID 重新恢复，不复用全局最近会话。

## 目标、后台与协作

- `/goal <目标>`：在独立后台会话执行原生 `/goal`；`/goal status|pause|resume|clear` 查看、暂停、恢复、清除。
- `/background <任务>`：独立会话执行；`/background list` 查看，`/background stop <ID>` 停止。聊天可以继续。
- `/stop`：停止当前聊天的执行与后台工作，暂停目标。
- `/team <任务>`：调用原生 `/teamwork`；原生子 agent 调用事件通过现有 team-event 回调展示，不假造独立 worker 状态。

状态保存至 `<SESSION_STORE_DIR>/antigravity-work-<bot>.json`，默认并发上限 2（或 bot 的 maxConcurrentTasks）。重启后恢复排队和运行记录，已完成但未交付的结果重新交付。恢复属于至少一次执行/交付；外部操作需要任务自身保证幂等，进程恢复不等于事务回滚。后台任务使用独立原生会话，不复制前台会话全部上下文。

ACP 没有可靠的回合内 token 预算限制，因此不接受 `/goal --budget`，也不支持 `allowedTools` / `maxTurns` 受限执行；明确报错，不悄悄忽略限制。CLI 累计 usage 不用作上下文占用。

## 验证范围

- 20 个相关测试文件、198 项测试通过，覆盖协议、会话、问答映射、配置、模型目录、额度及持久任务，并包含 Codex 回归。测试命令排除仓库 `.backups` 历史副本。后端/后台类型检查、独立模块 lint 与后台构建通过。
- 消息桥接集成测试覆盖任务、问题卡片、用户回复、文件交付和后续会话复用，使用模拟发送端与 ACP 后端，不向真实聊天发送测试消息。
- 本机真实 headless 验证对话、恢复与写文件；真实 ACP 验证模型目录、原生提问/回答、文件权限选择与写入，并在关闭进程后恢复会话，恢复后的回答保留前轮选择。原生 `/usage` 额度查询成功。
- 未更改实际机器人配置或重启运行服务；真实飞书聊天的上线验收尚未执行。

## 参考

- https://antigravity.google/docs/ide/extensions/acp
- https://agentclientprotocol.com/protocol/v1/session-setup
- https://agentclientprotocol.com/protocol/v1/elicitation
- https://antigravity.google/docs/cli/headless/
- Codex 接入提交：`af20f81`；连接兼容修复：`c1d96bc`。

## 2026-11-18：回复卡片模型与上下文

补齐原生模型与 ACP `usage_update` → `engineStats` → CardState 的映射。流式卡片显示当前上下文占用，完成卡片显示模型与占用；后台结果通过最终消息保留同一份元数据。上下文值直接取原生 `used` / `size`，不使用回合累计 token 计算；压缩后允许占用降低，未提供占用数据时只展示模型。支持会话初始化/恢复期间提前到达的 usage 通知及运行中的模型配置更新。

新增模型显示、实时占用、压缩后下降、无效值过滤和最终卡片渲染测试；相关 167 项测试、lint 与完整构建通过。
