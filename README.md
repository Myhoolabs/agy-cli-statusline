# agy-cli-statusline

> 面向 Windows 平台 **Google Antigravity CLI (`agy`)** 的极简实时状态栏配置与本地数据校准扩展（基于 [`agy-powerline`](https://github.com/wassim-azi/agy-powerline) + 零第三方依赖的前置校准层与单轮计时器）。

---

## 1. 这是什么？（项目定位与显示效果）

启用本配置后，`agy` 底部状态栏会替换为单行、高信息密度、支持窄屏自适应的实时监控条，左侧展示 4 个经过底层会话数据校准的核心指标，右下角以纯文本原样保留当前模型与思考等级/代号：

```text
💾 ●●●●●●●●●●●● 191.6K/512.0K (37.4%) │ 🪙 Tokens: 205.3K↑ 92.9K↓ │ ⚡ Cache hit: 97% │ ⏱️ Turn: 1m 24s               Gemini 4 Neon (XHigh)
```

### 显示元素与校准后数据口径

| 位置 | 显示元素 | 实现载体 | 口径与颜色预警规则 |
|---|---|---|---|
| **左 1** | **上下文占用（换 Thread 预警）** | `statusline-enrich.js` + `context`（`compact: true`） | 自动从当前会话只读 DB（`gen_metadata`）读取模型在 Antigravity 中的**真实有效上限**（如 Gemini 4 Neon / Argon High / Hydrogen XHigh / Orchestrator 为 `512.0K`，Gemini 3 / Hydrogen High / Argon Medium 为 `256.0K`；无 DB 时回退官方值），移除原 `>200k` 硬编码提前全红。<br>按真实占比分级变色：**`<60%` 正常甜点区**、`60%~74.9%` **黄色注意**（512K 约 `307K` / 256K 约 `154K`）、**`≥75%` 全红预警**（512K 约 `384K` / 256K 约 `192K`，在 ~90% 自动 compact 之前提示及时切换新 thread 或手动 `/compact`）。 |
| **左 2** | **累计输入 / 输出 Token** | `statusline-enrich.js` + `totalTokens`（`split: true`） | 修正 `agy` 原生 `total_input_tokens` 与当前上下文重复的问题，改为直接汇总当前会话所有模型请求（按 response ID 去重）的**真实累计未命中缓存新输入 `↑`** 与 **累计总输出 `↓`**（不含缓存重复读取，更贴近实际 credits 消耗）。 |
| **左 3** | **本轮累计缓存命中率** | `statusline-enrich.js` + `cacheHit` | 改为计算**当前这一轮**（最新 `USER_INPUT` 之后所有模型调用）的**累计缓存命中率** `turnCacheRead / (turnCacheRead + turnUncachedInput)`（新轮次首请求尚未返回时暂回退展示上一轮累计值），帮助直观估算本轮是否发生缓存失效及 credits 消耗；`≥80%` 绿、`50%~79%` 橙。 |
| **左 4** | **单轮耗时** | `turn-elapsed.js`（同进程零子进程调用） | 严格按「**发出最新一条消息 → AI 答完交还控制权**」单轮计时：运行中黄色实时跳秒，结束后青色定格。以会话 DB 的 `USER_INPUT` 步号与最终无 `tool_calls` 的 `PLANNER_RESPONSE DONE` 状态为锚点（并自动修复 `agy` 推送 `transcript_path` 缺失 `-cli` 的路径偏差、移除 `reviewing` 误判），**彻底杜绝后台任务残留或丢 `idle` 导致的跨轮累计成整场总耗时问题**。 |
| **右下角** | **模型与思考等级/代号** | `separator` + `model`（`raw: true`） | 位于 `separator` 弹性间隔右侧，隐藏 `🤖` 图标与前缀标签，原样输出如 `Gemini 4 Neon (XHigh)`、`Orchestrator (Argon)`。 |

### 窄屏自适应规则

- **常规宽度（`≥85` 列，如 100 / 120 / 140 列）**：100 列左右自动去掉左侧文字标签仅留图标与数值，右侧模型名保持原样带括号。
- **极窄终端（`80` 列）**：自动去掉标签并由 `agy-powerline` 的 `fitRow` 触发模型紧凑缩写（如 `4 Neon·XHigh`、`Orchestrator·Argon`），确保全部 5 项保留不被裁掉。

---

## 2. 最近更新说明（v2.0 — 2026-11-20）

本次是一次全面的**数据校准与稳定性重构**，重点解决了生产使用中排查出的 4 类真实问题：

1. **彻底修复「单轮耗时变成整场任务耗时」的 Bug**
   - 修复 `agy` CLI 传入的 `transcript_path` 缺失 `-cli`（`\.gemini\antigravity\...` 而非真实路径 `\.gemini\antigravity-cli\...`）导致日志兜底从上线起一直失效的问题；
   - 新增会话 SQLite DB 只读解析（`session-metrics.js`），以最新 `USER_INPUT` 步号与无 `tool_calls` 的最终 `PLANNER_RESPONSE DONE` 为轮次边界，新轮次自动清零、答完立即青色定格；
   - 将 `reviewing` 移出活跃运行态，避免等待审阅或残留后台进程拖着秒表一直跑。
2. **上下文占用改用模型真实有效上限 + 甜点区 / 换 Thread 预警**
   - 自动从 `gen_metadata` 读取当前模型在 Antigravity 中的真实有效上限（如 Neon `512.0K`、Gemini 3 / Hydrogen High `256.0K`），不再被理论 `1.0M` 窗口误导；
   - 取消硬编码 `exceeds_200k_tokens` 导致的 200K 提前全红与 `>200k` 标记，统一按真实占比 **`60%` 变黄 / `75%` 全红**（512K 模型对应约 `307K` 黄、`384K` 红），在约 `90%` 自动压缩前及时提示换 thread 或手动 `/compact`。
3. **缓存命中率升级为「本轮累计缓存命中率」**
   - 原生 `cacheHit` 只看最后 1 次请求的瞬时值，容易掩盖本轮开头掉缓存重算；现改为聚合当前轮所有模型调用的累计命中率，一眼看出本轮是否掉缓存、辅助估算 credits 消耗。
4. **Tokens 修正为「真实累计未命中缓存新输入 / 累计输出」并消除重复启动开销**
   - 修正原生 `total_input_tokens` 实际重复展示当前上下文大小的问题，改为真实累计未命中缓存新输入 `↑` 与累计输出 `↓`；
   - 通过 `statusline-enrich.js` 在单 Node 进程内完成 DB 校准、单轮耗时计算并直接加载 `agy-powerline` 渲染，省去每次刷新额外拉起 `cmd -> node` 子进程的开销，单次渲染耗时由约 `450~980ms` 降至约 `200~260ms`，消除 `SLOW_RENDER` 与 `EXEC_TIMEOUT`。

---

## 3. 仓库文件清单

```text
agy-cli-statusline/
├── README.md               # 项目说明、指标口径、更新说明与安装指南
├── install.ps1             # Windows PowerShell 一键安装/升级与自检脚本
├── session-metrics.js      # 零依赖只读解析器（路径纠偏 + node:sqlite 读取真实上限/Token/缓存/轮次）
├── statusline-enrich.js    # 同进程前置数据校准与渲染包装入口（零魔改 agy-powerline 本体）
├── statusline.config.json  # 已调优的 agy-powerline 配置模板（60%/75% 上下文阈值）
└── turn-elapsed.js         # 单轮耗时秒表（支持被 wrapper 同进程调用，也支持独立 CLI 兜底）
```

---

## 4. 在另一台 Windows 设备上安装或升级

### 前置条件

- Windows 10 / 11
- 已安装并登录 **Google Antigravity CLI (`agy`)**
- 已安装 **Node.js v22.5+ / v24+**（推荐使用内置 `node:sqlite` 的版本以启用全部 DB 校准功能；更低版本仍可正常运行并自动降级为日志/状态机模式）
- 终端建议安装 Nerd Font（可选）

---

### 方式 A：直接让另一台电脑的 `agy` 自动安装 / 升级（推荐）

如果目标 Windows 电脑已经装好了 `agy`，直接把下面这段话发送给它即可：

```text
请帮我参考 GitHub 仓库 https://github.com/myhoodiao/agy-cli-statusline，在这台 Windows 电脑上完整安装（或升级）agy 底部状态栏。

具体要求：
1. 克隆或拉取最新 main 分支代码，阅读 README.md 了解文件结构与校准机制；
2. 备份现有的 ~/.gemini/antigravity-cli/settings.json、~/.agy-powerline/statusline.config.json 与 statusline.cmd；
3. 运行仓库中的 install.ps1（会自动初始化/升级 agy-powerline、部署 session-metrics.js / turn-elapsed.js / statusline-enrich.js、生成 statusline.config.json 与 statusline.cmd、核对 settings.json 并运行 doctor）；
4. 确认 npx -y agy-powerline doctor 显示 spawn ok 与 problem log empty，并注入真实会话 JSON 验证 5 项指标均正确渲染且退出码为 0。
```

---

### 方式 B：PowerShell 一键脚本安装 / 升级

在目标 Windows 电脑的 PowerShell 中执行：

```powershell
git clone https://github.com/myhoodiao/agy-cli-statusline.git
cd agy-cli-statusline
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

若已克隆过仓库，拉取更新后重新运行 `install.ps1` 即可幂等升级（会自动备份原有配置）：

```powershell
git pull
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

`install.ps1` 会自动完成以下工作：
1. 检查 `node` 与 `npx`，并自动解析 `node.exe` 的 Windows `8.3` 无空格短路径；
2. 运行 `npx -y agy-powerline@latest init --yes` 初始化或升级 `agy-powerline` 核心文件；
3. 将 `session-metrics.js`、`turn-elapsed.js`、`statusline-enrich.js` 复制到 `%USERPROFILE%\.agy-powerline\`；
4. 读取模板 `statusline.config.json`，填入本机短路径与 `--no-warnings` 后写入 `%USERPROFILE%\.agy-powerline\statusline.config.json`（UTF-8 无 BOM）；
5. 更新 `%USERPROFILE%\.agy-powerline\statusline.cmd` 指向 `node --no-warnings "%~dp0statusline-enrich.js"`；
6. 校验或更新 `%USERPROFILE%\.gemini\antigravity-cli\settings.json` 中的 `statusLine` 字段；
7. 运行 `npx -y agy-powerline doctor` 进行健康自检。

安装或升级完成后，**新开或继续 `agy` 会话**即可立即生效。

---

### 方式 C：手动分步安装

1. **初始化 `agy-powerline`**：
   ```powershell
   npx -y agy-powerline@latest init --yes
   ```
2. **下载并放入 `%USERPROFILE%\.agy-powerline\`**：
   - `session-metrics.js`
   - `turn-elapsed.js`
   - `statusline-enrich.js`
   - `statusline.config.json`
3. **更新 `statusline.config.json` 中的 `exec.cmd`**（替换 `<YOUR_USERNAME>` 并使用无空格短路径与 `--no-warnings`）：
   ```json
   "cmd": "C:\\Progra~1\\nodejs\\node.exe --no-warnings C:\\Users\\你的用户名\\.agy-powerline\\turn-elapsed.js"
   ```
4. **更新 `%USERPROFILE%\.agy-powerline\statusline.cmd`**：
   ```bat
   @echo off
   setlocal DisableDelayedExpansion
   "C:\Program Files\nodejs\node.exe" --no-warnings "%~dp0statusline-enrich.js" %*
   ```
5. **核对 `%USERPROFILE%\.gemini\antigravity-cli\settings.json`**（正斜杠、不加引号）：
   ```json
   "statusLine": {
     "type": "command",
     "command": "C:/Users/你的用户名/.agy-powerline/statusline.cmd"
   }
   ```
6. **运行自检**：
   ```powershell
   npx -y agy-powerline doctor
   ```

---

## 5. Windows 关键踩坑与设计细节

1. **Windows `cmd /c` 路径与引号禁忌**：`settings.json` 中 `statusLine.command` 必须保持无引号正斜杠路径；`statusline.config.json` 的 `exec.cmd` 必须使用无空格 `8.3` 短路径。
2. **`--no-warnings` 不可省略**：Node v22.5+/v24 使用内置 `node:sqlite` 时默认会向 `stderr` 打印 `ExperimentalWarning`，在 `statusline.cmd` 与 `exec.cmd` 加上 `--no-warnings` 可确保标准错误完全干净。
3. **升级 `agy-powerline` 后需重新运行 `install.ps1`**：单独执行 `npx -y agy-powerline@latest init --yes` 会将 `statusline.cmd` 重置回直接调用 `statusline.js`；建议始终通过重新执行 `.\install.ps1` 完成一键升级与入口接线。
4. **只读安全与优雅降级**：`session-metrics.js` 严格以 `{ readOnly: true, timeout: 250 }` 打开 SQLite 会话库，永不写库也不阻塞 `agy`；遇到新空白会话、旧版 Node 或仿真 payload 时自动回退 `transcript.jsonl` / 原生字段，绝不中断状态栏渲染。

---

## 6. 日常维护与卸载

```powershell
# 1. 一键升级 agy-powerline 并保持校准层接线（在仓库目录执行）
powershell -ExecutionPolicy Bypass -File .\install.ps1

# 2. 健康检查与渲染诊断
npx -y agy-powerline doctor

# 3. 彻底卸载 statusLine 集成（--delete 会清理 agy-powerline 文件，自定义脚本可按需手动删除）
npx -y agy-powerline uninstall --yes --delete
```
