# 引擎配置（Claude Code / DeepSeek / MiniMax）

每个 bot 独立选引擎：`bots.json` 里的 `engine: "claude" | "deepseek" | "minimax"`（默认 `claude`），
管理台「机器人管理 → 编辑」的引擎下拉即可切换，选中 DeepSeek / MiniMax 会展开参数子表单。
同一台机器上多种引擎的 bot 可以并存混用。

所有引擎共享**同一个 Claude Code 运行时**（`@anthropic-ai/claude-agent-sdk`）——持久会话池、
Agent Teams、`/goal`、后台任务、记忆体系（CLAUDE.md / auto-memory / session 续接）对两者完全一致，
差别只在指向哪家的 API 和用谁的 key。DeepSeek 与 MiniMax 都走各家官方的 **Anthropic 兼容端点**，零 CLI 安装。

## Claude Code（默认，开箱即用）

运行时随 Luckagent 打包，无需额外安装。认证二选一：

| 方式 | 步骤 |
| --- | --- |
| API Key | `.env` 填 `ANTHROPIC_API_KEY`（可配 `ANTHROPIC_BASE_URL` 走中转网关）→ `luckagent restart` |
| 订阅登录 | 装 Claude Code CLI（`curl -fsSL https://claude.ai/install.sh \| bash`）→ 终端跑 `claude` 完成登录 → `.env` 填 `CLAUDE_EXECUTABLE_PATH=~/.local/bin/claude` |

> Claude 引擎默认用 **PTY 后端**（驱动本机真实的 `claude` CLI），因此需要 PM2 能找到 CLI。找不到时，飞书卡片会直接显示「启动任务失败：PTY backend requires the claude CLI binary…」——装好 CLI，或在 `.env` 用 `CLAUDE_EXECUTABLE_PATH` 指向它，然后 `luckagent restart`。DeepSeek / MiniMax 走 SDK 后端，没装 CLI 也能跑。

模型默认**跟随订阅档位**（不指定时由 Claude 官方按你的计划选：Pro→Opus 5，Max→Fable 5）；
要固定某个模型才设 `.env` 的 `CLAUDE_MODEL`（指定超出档位的会被静默降级，以回复页脚显示的实际模型为准）。
其余参数：`CLAUDE_MAX_TURNS` / `CLAUDE_MAX_BUDGET_USD` 是全局默认，
bot 级的 `model` / `maxTurns` / `maxBudgetUsd`（管理台「限制与预算」）可覆盖。

## DeepSeek（最省事：零安装，只要 key）

DeepSeek 官方提供 **Anthropic 兼容端点**（`https://api.deepseek.com/anthropic`），Luckagent 让它直接跑在
Claude 引擎的运行时上——**不用装任何 CLI**：

1. 申请 key：https://platform.deepseek.com → `.env` 填 `DEEPSEEK_API_KEY`（或在 bot 的 DeepSeek 子表单里按 bot 填）。
   **没有 Claude 账号的机器**再加一行 `LUCKAGENT_ENGINE=deepseek`（全局默认引擎），之后建的 bot 默认即用 DeepSeek——安装脚本检测到「只填了 DeepSeek key 且未装 Claude CLI」时会自动写入这行。
2. 新建 bot 默认继承安装时选定的全局引擎；需要按 bot 调整时在「机器人管理 → 编辑」的引擎下拉选 DeepSeek，模型二选一：
   `deepseek-v4-flash`（快、便宜、默认）/ `deepseek-v4-pro`（更强推理）。
   两个模型都**原生支持看图**（群里发图片给 bot，agent 用 Read 工具读取即可理解——已实测）；
   实验版 `deepseek-v4-flash-vision-exp` 仍可手填使用，但日常无需。
3. 保存重启即生效。会话内 `/model deepseek` 也可临时切换（临时切换的会话走逐回合执行路径，
   Agent Teams / /goal / 后台任务等持久会话特性不参与；要长期用请在 bots.json 或管理台把该 bot 的 engine 设为 deepseek）。

凭证注入是 **bot 级隔离**的：DeepSeek bot 与 Claude 订阅 bot 在同一台机器并存互不干扰
（每个 bot 的子进程注入自己的 endpoint 与 key，宿主机的 Claude 登录态不受影响）。

适合：高频轻任务（群日报、摘要、问答）、中文场景、成本敏感的 bot；复杂多步任务的可靠性与 Claude 有差距，重活建议留 Claude。

> 计费提示：管理台/统计里显示的费用是按 Claude 价目估算的（运行时不识别第三方价目），DeepSeek / MiniMax 实际账单以各自平台为准（通常远低于显示值）。

## MiniMax（零安装，原生看图）

MiniMax 同样提供 **Anthropic 兼容端点**（`https://api.minimaxi.com/anthropic`），接法与 DeepSeek 完全一致：

1. 申请 key：https://platform.minimaxi.com （支持订阅制 Coding Plan，key 以 `sk-cp-` 开头）→ `.env` 填 `MINIMAX_API_KEY`（或在 bot 的 MiniMax 子表单里按 bot 填）。全机默认用它则再加 `LUCKAGENT_ENGINE=minimax`（安装脚本选 MiniMax 时自动写入）。
2. 模型二选一：`MiniMax-M3`（旗舰、**原生看图**、默认）/ `MiniMax-M2.5`（上一代、更省）。
3. 保存重启即生效；会话内 `/model minimax` 临时切换的说明同上（走逐回合路径）。

凭证同样 bot 级隔离，与 Claude / DeepSeek bot 并存互不干扰。

## 指令文件（CLAUDE.md）如何生效

| 内容 | 生效方式 |
| --- | --- |
| bot 工作目录指令 `CLAUDE.md` | 两个引擎同一运行时，直接读取；`AGENTS.md` 是指向它的**符号链接**（建 bot 时自动创建），为你手动在工作目录运行的其他 agent 工具保留兼容 |
| 共用规范（`~/projects/CLAUDE.md`） | 生效（运行时向上遍历父目录） |
| 逐回合系统提示（工作目录、发送暂存目录、提问人 open_id 等） | 桥接注入，引擎无关 |

**日常只维护 `CLAUDE.md` 一个文件**即可。如果你曾手工创建过普通文件版的 `AGENTS.md`，系统不会覆盖它。

## 修改全局默认引擎与模型

管理台「系统配置 → 默认设置」可以直接改整机默认值（写入 `.env`，保存后确认即重启桥接生效）：

| 项 | `.env` 键 | 说明 |
| --- | --- | --- |
| 默认引擎 | `LUCKAGENT_ENGINE` | 没有单独设引擎的 bot 用它；新建 bot 也默认用它 |
| Claude 默认模型 | `CLAUDE_MODEL` | 推荐「跟随订阅档位」（不写）；也可手填模型 ID |
| DeepSeek / MiniMax 默认模型 | `DEEPSEEK_MODEL` / `MINIMAX_MODEL` | 下拉选择，清空 = 各引擎内置默认 |

生效优先级：会话里 `/model` 临时切换 > bot 自己的设置（机器人管理 → 编辑）> 全局默认。机器人列表的「模型」列显示每个 bot 实际生效的模型。

## 快速核对清单

| 引擎 | 需要终端做的事 | 其余 |
| --- | --- | --- |
| Claude | 无（API key 路线）或装 CLI + 登录（订阅路线） | `.env` / 管理台 |
| DeepSeek | **无**——只要申请个 key | `.env` 或管理台子表单 |
| MiniMax | **无**——只要申请个 key | `.env` 或管理台子表单 |

`luckagent doctor --json` 可核对运行时、PM2、bots、语音、生图等检查项。


## GPT（Codex 订阅，基础版）

新增独立的 `codex` 引擎，使用本机 `codex` CLI 的 ChatGPT 登录，不经过 Claude 运行时。
先安装 CLI 并运行 `codex login`，用 `codex login status` 确认登录。
在管理台机器人编辑中选择「GPT（Codex 订阅）」，展开 GPT 引擎设置，从下拉列表选择模型与该模型支持的推理强度；可点击「刷新模型列表」更新本机 Codex 模型目录。模型是否可调用仍以登录账号和实际请求为准。
`bots.json` 示例：

```json
{"name":"tiger","engine":"codex","codex":{"reasoningEffort":"medium"}}
```

模型留空跟随本机 Codex 默认，也可设置 `codex.model`。原有顶层 `model` 是 Claude 配置，不用于 Codex。
支持文本、多轮续接、工具状态、图片输入、文件回传和 `/stop`；`/model codex` 可临时切换，
切换时会开始新会话。旧 Claude 会话不会被 Codex 续接。

执行权限为 `workspace-write`，可写 bot 工作目录与本次输出目录，允许网络访问；CLI 无交互审批。
不使用 `--dangerously-bypass-approvals-and-sandbox`。引擎排除继承的 OpenAI API Key 与 API 地址，
强制使用 ChatGPT 登录；生图与语音 API 配置不变。

Codex 使用独立的常驻 App Server，原有 `codex exec` 会话可通过线程 ID 续接。
支持 `/goal <目标>`、`/goal status|pause|resume|clear`；可用 `--budget <token 数>` 指定预算。
目标由 Codex 原生目标调度执行，进度回传飞书；`/stop` 停止本聊天当前执行及后台任务，并暂停活跃目标。
支持 `/background <任务>`、`/background list`、`/background stop <ID>`，后台任务使用独立会话，普通聊天可继续。
目标与后台任务状态保存到 `<SESSION_STORE_DIR>/codex-work-<bot>.json`；重启时恢复活跃目标与未完成后台任务。
后台恢复会沿用原会话；执行外部操作的任务仍需检查恢复后的结果，不能把进程恢复等同于事务回滚。
`/team <任务>` 或自然语言明确要求分工可使用 Codex 子 agent，执行卡片展示团队事件。
Luckagent 自身团队成员也可选择 `codex`，与 Claude / DeepSeek / MiniMax 混合协作。
Bot 自身继续通过 `AGENTS.md` 链接共用 `CLAUDE.md`；Codex 适配层明确加载用户/祖先目录的共用 `CLAUDE.md`，无需维护两份规则。
手动 `/resume` 历史选择器仍为 Claude 专用；Codex 日常对话与持久工作自动续接。
指定 `allowedTools` / `maxTurns` 的受限 API 任务会明确报错，不会静默忽略限制。
卡片页脚从本机会话记录读取实际模型、最近一次推理的上下文用量与窗口大小。费用固定显示 `$0.00`。
订阅额度以账号为准；界面中的零美元不代表订阅没有费用。
Codex 可以读取 bot 的 `AGENTS.md`，并在逐回合提示中发现用户与 bot 的 `.claude/skills`；
Codex 自己的原生 skills 仍按其 CLI 配置加载。

试用时只设置测试 bot 的引擎，保留 `LUCKAGENT_ENGINE` 和其他 bot 配置。
回退测试 bot 时将 `engine` 改回 `claude` 并重启桥接，原有顶层 Claude 模型配置仍保留。
