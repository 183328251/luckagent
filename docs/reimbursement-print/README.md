# 报销打印助手

为显式配置 `reimbursementPrint.enabled: true` 的飞书 bot 启用独立、无模型业务模块。默认关闭，企业审批定义与财务节点由各自配置提供。

## 已确定行为

- 菜单发送或员工在私聊发送固定文本 `获取报销单`，首尾空白忽略，其余必须完全一致。
- 返回本人最新 5 笔合格报销，无翻页入口；少于 5 笔显示实际数量，无记录则提示。
- 合格为 APPROVED，或 PENDING 且所有当前 PENDING 活动任务都位于配置的财务节点。并行非财务任务仍活动时保守拒绝。
- 财务节点须由业务管理员明确确认后配置。每次查询与打印 PENDING 单据都核对审批定义；节点失配时仅开放 APPROVED，并在选单提示。
- 打印前重新查询详情，校验定义、本人 open_id、状态和明细合计。以原生审批发起人为归属，不开放代提交业务；如果存在另行填写受益人的流程，必须先配置明确的归属映射，再开放该流程。
- XLSX 占位符填充后生成带嵌入中文字体、可搜索文本的 A4 PDF，发送到创建选单的原私聊。没有公开下载链接，没有审批/付款状态写入。
- 其他文本（含未知斜杠命令、文件）使用红色“使用提示”卡片回复固定说明。保留私聊 `/status`、`/stop`、`/reset` 和 `reset` 的原管理处理；API/定时/跨 bot 模型任务入口拒绝执行。群消息仅提示私聊。
- 查询与生成PDF期间复用普通 bot 的蓝色 Thinking 卡片；查询完成原卡更新为绿色选单，空结果显示绿色完成卡，失败显示红色错误卡。选单恢复灰底3:1分栏、左侧加粗单号和金额、右侧打印按钮。
- 选单绑定当前 bot 实例、tenant_key、open_id、chat_id、卡片 message_id，默认 15 分钟有效。按钮只含不透明会话和选项 ID；重启后旧卡无效。卡片同步校验后快速 ACK，后台核验与生成 PDF。
- 同选项重投/双击只启动一次；同用户同单据并发请求被阻止。上传或发送异常后不自动重复发文件，用户核对会话后重新获取选单补打。

## 模块边界

- `src/modules/reimbursement-print/`：审批 API 适配、确定性字段/金额处理、选单会话、卡片生成与 PDF 子进程。
- `scripts/reimbursement-print/render.py`：XLSX 模板渲染；只需现有 Python 依赖 openpyxl、PyMuPDF。
- `assets/reimbursement-print/template.xlsx`：受版本管理的模板基线。
- `src/index.ts`：复用当前应用 SDK 客户端和收发器，在启动时装配模块。
- `MessageBridge`：入口路由、保留管理命令、阻断模型 API 任务；模块关闭时保留原行为。
- `event-handler.ts`：启用时保留真实私聊类型、租户及原始文本，不拉取引用或历史模型上下文；回调转发可信 operator.tenant_key。

没有第二套机器人连接、消息订阅或凭证缓存。模块启用采用进程启动配置，不支持运行中直接切换；旧进程中的任务不会被开发操作终止。正式切换前让该 bot 原模型任务完成，或仅停止其任务。

## 配置与模板位置

仅将 `config.example.json` 的 `reimbursementPrint` 字段合并到 `bots.json` 中 **print-assist-bot** 的条目。其他 bot 不配置，默认不启用。

将基线模板 `assets/reimbursement-print/template.xlsx` 复制到 bot 工作区，例如：

`~/projects/print-assist-bot/reimbursement-print/template.xlsx`

`templatePath` 相对该 bot 的 `defaultWorkingDirectory` 解析。Python 使用实际拥有依赖的解释器，必要时配置为 `~/.luckagent/venv/bin/python（配置中请展开为绝对路径）`。`fontPath` 可选：macOS 自动使用 Songti.ttc，Linux 自动尝试 `/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc`；其余环境须指定可嵌入中文字体文件。

配置示例使用占位值；仅在本机 bots.json 中填入实际企业审批定义与节点 ID。

## 修改 XLSX 模板

管理员替换上述文件即可在下一次打印生效；已发送文件保持原样。先备份旧模板并运行合成预览验证，不从员工聊天附件自动安装模板。

- 使用第一个工作表，A4 纵向、12.5mm 边距、黑白细线中文表格。
- `{{报销月份}}`、`{{申请人}}`、`{{合计金额}}`、`{{币种}}` 为经过验证的系统字段。
- 唯一包含 `{{费用日期}}` 的行为明细模板行，每笔费用自动复制该行；其紧邻上一行为每页重复的列标题。
- 明细占位符：`{{费用日期}}`、`{{项目编号}}`、`{{费用类型}}`、`{{说明}}`、`{{金额}}`。
- 其他顶层标量审批字段可用同名占位符，例如 `{{报销抬头}}`。不存在或尚未映射的字段报错，不静默打印空白。新增复杂人员/关联/附件字段需要扩展映射代码。
- 可改列宽、行高、字号（6–24pt）、左右/居中对齐和同一行内的合并单元格；长说明自动换行并可跨页。合计只放在明细行之后。
- 不支持公式、图表、图片、跨行合并、宏、任意 Excel 打印效果。渲染是受约束的 XLSX 表格引擎，不依赖安装 Excel/LibreOffice；字体统一使用配置的中文字体，线条统一细黑线。
- 金额用整数分，人民币两位小数；缺失、超过两位小数、多币种及合计不符拒绝生成，不能用模板公式改业务合计。

合成模板验证：

```sh
python3 scripts/reimbursement-print/test_render.py
```

## 权限与平台检查

复用打印助手自身应用凭证。审批只读权限：`approval:approval.list:readonly`、`approval:approval:readonly`；真实申请人姓名还需要该应用可见的通讯录基础资料权限（如 `contact:user.base:readonly`）和数据范围。消息/卡片发送、文件上传沿用现有 bot 权限。禁止借用 tiger 的 open_id、凭证或 CLI profile。

平台：启用机器人能力、配置接收消息；菜单发送文本为 `获取报销单`；检查 `card.action.trigger` 是否通过当前长连接实际送达。仓库历史有旧按钮格式的移动端兼容问题，本模块采用 Card 2.0 顶层 button + callback behaviors，不能以 mock 通过代替平台验收。如当前应用需要另配卡片回调地址，先确认平台支持的接入方式再上线；本次没有擅自新增公网 HTTP 回调服务。

API 使用 SDK 的 tenant token 注入与缓存。列表分页参数放 query，user_id/approval_code 放 body；不设置时间边界，扫描接口全部可用历史，详情按 start_time 降序、实例 ID 稳定排序，过滤后取 5。不会将接口前 5 条误当最新合格 5 条。完整扫描失败则报错，不返回不完整的“最新”结果；历史较多的账号首次查询可能较慢。

官方接口参考：[查询实例](https://open.feishu.cn/document/server-docs/approval-v4/approval-search/query-2)、[实例详情](https://open.feishu.cn/document/server-docs/approval-v4/instance/get)、[审批定义](https://open.feishu.cn/document/server-docs/approval-v4/approval/get)。

## 发布与回滚流程

1. 保留当前源码、产物和 print-assist-bot 配置快照。确认两位有授权的测试员工，先验证不能交叉读单，再测试实际打印；不新建/撤回真实审批，不向未经授权员工发测试消息。
2. 核对模板、Python、中文字体、应用只读权限和当前定义中的财务 node_id。
3. 在 print-assist-bot 条目合并配置，验收窗口才设置 enabled=true。该 bot 的原模型任务先完成或单独停止。
4. 构建并发布 bridge 产物，同时发布 `scripts/reimbursement-print/render.py`。模块通过相对路径从 dist/modules/reimbursement-print 定位仓库 scripts，不能只拷贝孤立 JS 文件。
5. 当前入口是一个进程管理多个 bot；即使业务开关只影响打印助手，重启共享 bridge 仍会短暂重连同进程全部 bot。由负责人安排窗口后执行，不能承诺单 bot 无中断发布。执行前应取得对应发布窗口授权。
6. 验收菜单/手输、手机按钮、0/2/5笔、本人/他人、已通过/财务/撤回、过期卡、双击、PDF 字体与跨页；发送失败不假报成功。
7. 回滚优先恢复旧产物并移除/关闭该 bot 新配置，在同样发布窗口重启；模板错误可以只恢复旧 XLSX，无需重启。关闭业务模块会恢复该 bot 原模型模式，若要保持禁用模型，应先停用该 bot 的接收入口而非直接关闭开关。会话不持久化，重启后的旧卡不可打印。

## 验证记录

见 `validation.md`。实际飞书两账号、菜单和移动端卡片回调需在各自部署环境验收；本地合成测试完成不代表已上线。
