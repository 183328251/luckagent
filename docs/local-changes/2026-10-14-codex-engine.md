# GPT / Codex 引擎本地更新与上游合并依据

记录日期：2026-10-14（Asia/Shanghai）。实施时间：10 月 13 日晚至 14 日凌晨。

这是在上游 Luckagent **v0.7.25 / `e7c63db`** 上增加的本地功能，根 `package.json` 版本号仍为 `0.7.25`。记录建立时实现尚未提交；随后随本人仓库初始化纳入本地定制提交，仓库维护方式见 [本地定制维护](README.md)。上游自身的更新日志保留不动，本次入口单独标为“本地定制”。

## 目的与上线范围

为 bot 增加 ChatGPT 订阅登录的 GPT 引擎，使日常聊天、目标、团队和后台任务尽量与原 Claude 使用方式一致。内部引擎名为 `codex`，管理台显示 GPT / Codex 订阅。

本次只把 **Tiger** 作为 Codex 测试 bot；其他 **12 个 bot 保持 Claude**。高级功能上线时没有修改 `bots.json`、`.env` 或全局默认引擎，并核对了配置文件哈希。用户后续使用反馈：暂未发现问题。

## 最终行为与需要保留的设计

### 独立运行时与会话隔离

- Codex 不通过 Claude SDK 代理。首版使用 `codex exec`，最终默认执行器改为每个 bot 独立的常驻 `codex app-server`，保留首版执行器及其辅助函数。
- 使用本机 Codex 的 ChatGPT 登录；排除子进程继承的 OpenAI API Key / API 地址，强制 OpenAI provider 与 ChatGPT 登录。生图、语音的原有 API 配置不随聊天引擎切换。
- `engine: "codex"` 和 `codex.model` / `codex.reasoningEffort` 是独立配置；顶层 Claude `model` 保留，不误用于 GPT。模型留空时跟随本机 Codex 默认模型。
- 会话 ID 和临时模型带引擎归属。Claude 与 Codex 之间切换时不能把另一引擎的会话 ID 直接拿去续接；旧版 Codex CLI 线程可由 App Server 恢复。
- 使用 `workspace-write`，输出目录加入本轮可写范围，允许网络；无交互审批时对需要审批的请求拒绝处理，不开启全面绕过沙箱的参数。

### 管理台与回复卡片

- GPT 选项展开折叠设置区，模型使用本机目录下拉选择，支持刷新及对应模型的推理强度。
- 模型目录接口沿用管理台认证，不把登录材料或 API 凭证返回前端。
- 回复卡片显示实际模型、最近一次推理的上下文用量与窗口大小；费用按用户要求固定 `$0.00`，并非订阅额度或账单查询。
- 基础 CLI 路径通过会话记录补全统计；常驻路径接收原生 token usage 通知。上下文使用最近一轮值，不能误用累计 token 总数。

### 目标、团队、后台与提问

- `/goal <目标>`、`/goal status|pause|resume|clear`，支持 `--budget <token 数>`。目标使用 Codex 原生 goal API，明确标记用户发起。
- `/team <任务>` 或明确要求分工的自然语言使用原生子代理；卡片显示团队事件。Luckagent 自身团队成员也允许选择 Codex，可与其他引擎混合使用。
- `/background <任务>`、`/background list`、`/background stop <ID>`。后台任务 fork 独立线程，主聊天可以继续；完成结果和文件投递到发起聊天。
- `/stop` 中断当前执行、清理后台终端、停止本聊天后台任务并暂停活跃目标；`/reset` 清理本聊天持久工作及线程。
- 工作状态保存至 `<SESSION_STORE_DIR 或 ~/.luckagent>/codex-work-<bot>.json`；重启恢复活跃目标和未完成后台任务，暂停目标保持暂停，已投递结果避免重复通知。
- 目标初次执行走普通聊天交互链路；需要用户回答时走现有问题卡片。无人值守的目标/后台问题发回原聊天，多项问题逐项收集答案，并按聊天隔离。
- 中断与原生 turn 启动确认存在竞态，必须处理中断后的迟到确认，避免已停止任务又开始运行或旧 turn 完成事件结束新任务。
- 活跃目标被新消息引导时保留原输出暂存目录，避免清理掉仍在生成的文件。

### 规则文件与 Claude 兼容

- Tiger 工作目录原有 `AGENTS.md` 指向 `CLAUDE.md`。原生文档发现增加 `CLAUDE.md` fallback；适配层显式读取用户级及祖先目录共享 `CLAUDE.md`，按真实路径去重，无需另维护 GPT 规则副本。
- 未修改项目外的共享规则文件。已有独立普通文件 `AGENTS.md` 的 bot 仍需自行保证两份规则一致。
- **团队 CLI 默认继承父 bot 的引擎**：旧 CLI 未指定参数也会发送 `engine: codex`，旧后端此前未接受该值，实际上仍继承父 bot。现在后端接受 Codex 后，CLI 必须改为仅在用户显式指定时传 `engine`，否则 Claude 团队会发生行为变化。
- 只有有效引擎为 Codex 的聊天进入新增高级命令路径，原有 Claude / DeepSeek / MiniMax 执行逻辑继续保留。

## 文件对应表

以下为本次实现文件；另有本记录和 `CHANGELOG.md`。合并时以最终实现为准，不要只重放首版 CLI 接入。

| 文件 | 改动用途 / 合并重点 |
| --- | --- |
| `src/engines/codex/index.ts` | 注册 Codex 引擎，最终默认创建持久执行器 |
| `src/engines/codex/app-server-client.ts` | stdio JSON-RPC、初始化、事件/请求、中断及进程生命周期 |
| `src/engines/codex/persistent-executor.ts` | 线程/turn、goal、原生子代理、独立后台、持久恢复、问题与审批处理 |
| `src/engines/codex/instructions.ts` | 用户/祖先共享 CLAUDE.md 加载与去重 |
| `src/engines/codex/executor.ts` | 首版 CLI 执行器及环境、路径、输入提示辅助函数 |
| `src/engines/codex/jsonl-translator.ts` | CLI 事件转换为桥接 SDK 消息 |
| `src/engines/codex/session-stats.ts` | 实际模型、上下文、零费用卡片统计 |
| `src/engines/codex/model-catalog.ts` | 本机可用模型目录、缓存与刷新 |
| `src/engines/index.ts`、`src/engines/types.ts` | 引擎注册、Codex 配置及会话引擎归属类型 |
| `src/config.ts` | bot/global 引擎解析、Codex 独立配置、团队引擎校验 |
| `src/bridge/message-bridge.ts` | 按聊天选执行器、会话隔离、高级命令、异步结果/文件、问题、关闭与运行状态 |
| `src/bridge/command-handler.ts` | Codex 模型/命令支持，新增可选引擎命令处理回调 |
| `src/bridge/outputs-manager.ts` | 活跃 Codex 执行保留输出目录，取消提前清理 |
| `src/api/bot-registry.ts`、`src/api/env-defaults.ts` | 引擎展示和默认配置处理 |
| `src/api/routes/bot-routes.ts` | bot Codex 配置校验/保存 |
| `src/api/routes/admin-routes.ts` | 已认证的 Codex 模型目录接口 |
| `src/api/routes/agent-team-routes.ts` | 团队成员支持四种引擎 |
| `packages/admin-ui/src/api/types.ts` | 前端引擎、Codex 配置、模型目录类型 |
| `packages/admin-ui/src/pages/BotFormDrawer.tsx` | GPT 折叠配置、模型与推理强度下拉、功能说明 |
| `packages/admin-ui/src/pages/DefaultsCard.tsx` | 默认引擎设置中的 GPT 支持 |
| `packages/cli/src/teams.ts` | 未指定引擎时省略参数，保持继承语义 |
| `src/skills/luckagent-team/SKILL.md`、`packages/skills/luckagent-team/SKILL.md` | 同步团队引擎选择说明，两份都要保留 |
| `docs/engines.md` | Codex 安装、配置、命令与限制说明 |

测试文件：`tests/codex-{executor,jsonl-translator,session-stats,model-catalog,engine-isolation,persistent}.test.ts`、`tests/command-handler-model-status.test.ts`、`packages/cli/tests/teams.test.ts`。

## 验证记录与已知边界

- 完整桥接测试：85 个文件、973 例通过；之后的交互和竞态修正另跑相关测试，持久执行器 14 例、CLI 15 例通过。各轮数字不是互不重叠的总和。
- 后端/CLI 编译、前端构建与类型检查通过；新增核心文件 lint 通过。
- 在本机 Codex CLI **0.162.1** 验证：共享规则读取、多轮续接、目标完成、原生子代理、后台与主聊天并行、停止、重启恢复、暂停目标保持暂停。
- 使用假的发送器验证 MessageBridge 目标/后台命令、原聊天文件投递、卡片统计、停止与重置，不向飞书发测试消息。
- 上线后 13 个 bot 恢复；配置哈希未变，Tiger 两轮实机对话续接成功，返回费用为 0。后续用户使用暂未发现问题。
- 手动 `/resume` 历史选择器仍为 Claude 专用；Codex 日常聊天与持久工作自动续接。
- 指定 `allowedTools` / `maxTurns` 的受限 API 任务明确报错，不能宣称所有 Claude API 限制已对齐。
- 后台恢复不是事务回滚；外部操作中断后恢复仍可能需要检查实际结果。
- 没有宣称 Claude auto-memory 等所有记忆内部机制已在 Codex 中完全复制；本次落实的是规则加载、会话续接及上述执行功能。

## 后续上游合并流程

### 10 月 14 日后续：只读额度卡片

系统总览新增 `packages/admin-ui/src/components/SubscriptionUsageCard.tsx`，由 `OverviewPage.tsx` 引入。后端 `src/engines/codex/subscription-usage.ts` 通过原生 `account/rateLimits/read` 查询，`admin-routes.ts` 增加已认证的 `GET /admin/api/codex/usage`（`?refresh=1` 手动刷新）。

展示账号共享额度而非单 bot 用量；保留原生多额度桶和实际窗口长度，显示剩余/已用百分比、订阅类型、北京时间重置时间、免费重置机会和上次成功查询时间。页面每 3 分钟轮询，隐藏标签页暂停；后端普通缓存 2 分钟，手动刷新最短间隔 10 秒，并发查询共用一次请求。查询最长等待 15 秒，失败保留旧快照并明确标记，未知额度不当作 0% 使用。

仅返回白名单展示字段，不返回账号标识、邮箱、登录凭证或重置机会 ID；没有消费重置机会的接口或按钮。每次查询创建临时只读 App Server 连接，完成后关闭，不干扰 bot 的持久执行连接。新增 `tests/codex-subscription-usage.test.ts` 5 例，覆盖字段过滤、多桶、缓存与并发、失败保留、缺失额度；与管理台路由测试共 19 例通过，前后端编译及前端构建通过。Claude 订阅额度卡片留待后续评估，本次未实现。

合并上游时额外保留以上文件/接口、共享账号语义、凭证过滤和只读边界。

后续界面调整：进度条填充表示**已使用额度**，标题同时显示已用和剩余百分比；使用量达到 75% / 90% 时变黄 / 红，避免把剩余量误读成消耗进度。

### 后续：Claude 订阅额度

左侧卡片已接入 Claude，复用 `SubscriptionUsageCard` 的展示组件，以 `engine="claude"` 选择 `GET /admin/api/claude/usage`。右侧 GPT 保持原接口；Claude 不显示免费重置次数。

新增 `src/engines/claude/subscription-usage.ts`：在 `SESSION_STORE_DIR` 或 `~/.luckagent` 下专用查询目录启动独立 Claude Code PTY，以屏幕阅读模式执行 `/usage`，通过 headless xterm 处理终端重绘，只提取订阅类型、当前 5 小时和所有模型每周额度。关闭 hooks、工具和 MCP，移除 API key/第三方 provider 环境覆盖，使用本机 Claude 订阅登录；强制 `TZ=Asia/Shanghai`，查询完成或 30 秒超时后终止自有进程，不接触 bot 会话。普通缓存 2 分钟、手动刷新最短间隔 10 秒、并发去重；失败保留上次结果，不记录或返回完整终端文本、账号信息及本地技能统计。

实测 Claude Code 2.1.299：Pro，5 小时已用 17%，每周已用 41%，重置时间正常。`tests/claude-subscription-usage.test.ts` 新增 4 例，覆盖额度提取、未知时区/缺失窗口、跨天/跨年及缓存失败保留；与 Codex 额度、管理台路由共 23 例通过。实际查询为交互式文本解析，不是稳定结构化 API；升级 Claude CLI 时须复测标题、日期格式、刷新完成提示、就绪提示和进程退出。解析失败显示不可用或旧结果，不能悄悄当作零使用量。

1. 更新前备份代码、构建产物、配置及运行状态。先保存或提交本地实现、未跟踪的 `src/engines/codex/` 和新增测试；只保存 `git diff` 会遗漏未跟踪文件。备份中的配置/会话可能含敏感数据，不应提交上游。
2. 以 `e7c63db` 为本次上游基线，比较新上游的引擎接口、桥接执行/停止/重置/输出生命周期、团队校验和管理台设置。不要直接用旧版本整文件覆盖新上游。
3. 优先解决 `message-bridge.ts`、`command-handler.ts`、`config.ts`、引擎类型/注册、管理台表单的冲突；保留上游容量检查、队列、认证、附件、输出清理等修复，同时按有效引擎接入 Codex。
4. 检查团队 CLI 继承语义与两份技能说明；检查会话归属、默认模型重置、原生 turn 事件、停止竞态、后台结果聊天归属和持久状态格式。
5. 上游若也加入 Codex，比较认证方式、线程/goal/job 状态与行为，规划迁移后再合并；不能简单保留两套同名引擎或覆盖现有状态文件。
6. 在隔离目录和临时 `SESSION_STORE_DIR` 完成测试，避免回归测试读写在线定时任务/会话。合并后按当前上游脚本构建后端、管理台及 CLI；仅拷贝 TypeScript 文件不会更新运行中的 `dist`。
7. 确认 bot 空闲后重启，检查配置未变、13 个 bot（或届时实际数量）恢复、Tiger 连续对话、目标、团队、后台并行及恢复、文件投递和卡片统计；至少核对一个仍使用 Claude 的 bot。

建议回归命令（在隔离副本中运行；本机 Codex/桥接集成测试另用无飞书发送的测试程序验证）：

```sh
SESSION_STORE_DIR=/private/tmp/luckagent-merge-tests npm run test:bridge
npm run test -w @luckagent/cli
npm run build
```

## 本地备份与部署证据

路径相对仓库根目录。这些是本机恢复材料，换机器前应另行保存，不能假设 `/private/tmp` 长期存在。

| 材料 | 路径 |
| --- | --- |
| GPT 首次接入前完整备份 | `.backups/luckagent-before-gpt-20261013-232337.tar.gz` 及 `.sha256` |
| 高级功能上线前完整备份 | `.backups/luckagent-before-codex-v2-20261014-012534.tar.gz` 及 `.sha256` |
| 首版改动包 | `.backups/codex-tiger-change-20261013.tar.gz` |
| 高级功能改动包 | `.backups/codex-v2-change-20261014.tar.gz`（包含该阶段文件哈希清单） |
| 高级功能安装前源码/产物回滚包 | `.backups/codex-v2-install-before-2026-10-13T17-49-30-456Z.tar.gz` |
| 安装前 Tiger 会话快照 | `.backups/2026-10-13T17-49-30-456Z-sessions-tiger.json` |
| 分阶段部署与验证记录 | `.backups/codex-tiger-deployment.json` |

完整工程备份不包含 `~/.luckagent` 全部运行状态、`~/projects`、`~/.claude`、`~/.codex` 或 PM2 状态。高级功能安装时另外保存了 Tiger 会话快照；后续升级仍应另外备份持久目标/后台文件和相关运行状态。恢复原代码不能代替恢复这些外部状态。
