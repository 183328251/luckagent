# 本地定制维护

本地仓库以原作者 Luckagent 为基础，保留上游提交历史，并在 `main` 上维护已验证的定制。

| 远程 | 用途 | 地址 |
| --- | --- | --- |
| `origin` | 本人仓库，保存定制版本 | `https://github.com/183328251/luckagent.git` |
| `upstream` | 原作者仓库，获取更新 | `https://github.com/haoyan-yam/luckagent.git` |

定制记录：[2026-10-14 GPT / Codex 引擎](2026-10-14-codex-engine.md)。

## 后续更新

先备份配置与运行状态，确保工作区修改已提交，再在升级分支合并上游：

```sh
git fetch upstream
git switch main
git switch -c upgrade/upstream-YYYYMMDD
git merge upstream/main
```

按对应定制记录解决冲突、完成测试与构建。验证通过后合入 `main` 并推送：

```sh
git switch main
git merge upgrade/upstream-YYYYMMDD
git push origin main
```

之后再安排部署和重启。Git 合并不会自动更新运行中的构建产物；现有 `luckagent update` 的自动升级流程也不等于上述定制合并流程，维护本地修改时优先按升级分支审查。

## 提交范围

提交源码、测试、文档与锁文件；不提交 `.env`、`bots.json`、`.backups/`、日志、数据库、会话和登录凭证。Git 管理代码，配置和运行状态仍需独立备份。不要把本机 `.backups` 整包传到仓库。

首次定制提交采用仓库级作者配置 `183328251 <183328251@users.noreply.github.com>`，不修改机器的全局 Git 身份。
