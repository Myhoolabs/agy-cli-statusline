# agy-cli-statusline

> 面向 Windows 平台 **Google Antigravity CLI (`agy`)** 的极简实时状态栏配置与单轮耗时秒表扩展（基于 [`agy-powerline`](https://github.com/wassim-azi/agy-powerline) + 零依赖 `exec` 计时挂件）。

---

## 1. 这是什么？（项目定位与显示效果）

启用本配置后，`agy` 底部状态栏会替换为单行、高信息密度、支持窄屏自适应的实时监控条，左侧展示 4 个核心指标，右下角以纯文本原样保留当前模型与思考等级/代号：

```text
💾 ●●●●●●●●●●●● 176.0K/1.0M (17.6%) │ 🪙 Tokens: 184.8K↑ 53.9K↓ │ ⚡ Cache hit: 98% │ ⏱️ Turn: 4m 00s                   Orchestrator (Argon)
```

### 显示元素与数据口径

| 位置 | 显示元素 | 实现载体 | 说明与渲染规则 |
|---|---|---|---|
| **左 1** | **上下文占用** | `context`（`compact: true`） | 12 格点阵进度条 + `已用/上限 (%)`，随占用率变色（<70% 正常，≥70% 警告，≥90% 危险） |
| **左 2** | **累计输入/输出 Token** | `totalTokens`（`split: true`） | 显示当前会话累计输入 `↑` 与输出 `↓`（标签 `Tokens`） |
| **左 3** | **缓存命中率** | `cacheHit` | 读取最近一次请求的缓存命中百分比（≥80% 绿色，≥50% 橙色，标签 `Cache hit`） |
| **左 4** | **单轮耗时** | `exec` + `turn-elapsed.js` | 运行中黄色实时跳秒，回到 `idle` 后定格为本轮总耗时（标签 `Turn`）；冷启动/恢复会话时反向扫描 `transcript.jsonl` 自动回填 |
| **右下角** | **模型与思考等级/代号** | `separator` + `model`（`raw: true`） | 位于 `separator` 弹性间隔右侧，隐藏 `🤖` 图标与前缀标签，原样输出如 `Orchestrator (Argon)`、`Gemini 2.5 Pro (High)` |

### 窄屏自适应规则

- **常规宽度（`≥85` 列，如 100 / 120 / 140 列）**：100 列左右会自动去掉左侧文字标签仅留图标与数值，右侧模型名仍保持原样带括号（如 `Orchestrator (Argon)`）。
- **极窄终端（`80` 列）**：自动去掉标签并由 `agy-powerline` 的 `fitRow` 触发模型紧凑缩写（如 `Orchestrator·Argon`），确保全部 5 个显示元素保留不被裁掉。

---

## 2. 仓库文件清单

```text
agy-cli-statusline/
├── README.md               # 项目说明、安装指南与 Windows 避坑文档
├── install.ps1             # Windows PowerShell 一键安装与自检脚本
├── statusline.config.json  # 已调优的 agy-powerline 配置模板
└── turn-elapsed.js         # 零第三方依赖的单轮耗时秒表与日志回填脚本
```

---

## 3. 在另一台 Windows 设备上安装

### 前置条件

- Windows 10 / 11
- 已安装并登录 **Google Antigravity CLI (`agy`)**
- 已安装 **Node.js v20+**（带 `npm` / `npx`）
- 终端建议安装 Nerd Font（可选；普通终端也可正常使用核心文本和大部分符号）

---

### 方式 A：直接让另一台电脑的 `agy` 自动安装（推荐）

如果目标 Windows 电脑已经装好了 `agy`（或你正开着 `agy` 对话），直接把下面这段话复制发送给它即可：

```text
请帮我参考 GitHub 仓库 https://github.com/myhoodiao/agy-cli-statusline，在这台 Windows 电脑上完整安装并配置 agy 底部状态栏。

具体要求：
1. 先克隆或下载该仓库到临时目录，阅读 README.md 了解各文件用途与 Windows 路径注意事项；
2. 如果本机已有 ~/.gemini/antigravity-cli/settings.json 或 ~/.agy-powerline/statusline.config.json，先做好备份；
3. 优先运行仓库中的 install.ps1（或按 README 手动步骤等价执行）：安装/初始化 agy-powerline，部署 turn-elapsed.js 到 %USERPROFILE%\.agy-powerline\turn-elapsed.js，并将 statusline.config.json 中的 exec.cmd 替换为本机实际的 Node 8.3 无空格短路径与 turn-elapsed.js 路径；
4. 确认 ~/.gemini/antigravity-cli/settings.json 中的 statusLine.command 为正斜杠且不带引号；
5. 运行 npx -y agy-powerline doctor 确认 spawn ok 与 problem log empty，并向 cmd.exe /c %USERPROFILE%\.agy-powerline\statusline.cmd 注入仿真 JSON 验证左 4 项与右下角纯文本模型（如 Orchestrator (Argon)）均正常渲染、退出码为 0。
```

---

### 方式 B：PowerShell 一键脚本安装

在目标 Windows 电脑的 PowerShell 中执行：

```powershell
git clone https://github.com/myhoodiao/agy-cli-statusline.git
cd agy-cli-statusline
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

`install.ps1` 会自动完成以下工作（幂等且会自动备份原有配置）：
1. 检查 `node` 与 `npx` 是否可用，并自动解析 `node.exe` 的 Windows `8.3` 无空格短路径；
2. 运行 `npx -y agy-powerline@latest init --yes` 初始化运行文件与 `statusline.cmd`；
3. 将 `turn-elapsed.js` 复制到 `%USERPROFILE%\.agy-powerline\turn-elapsed.js`；
4. 读取模板 `statusline.config.json`，动态填入本机短路径后写入 `%USERPROFILE%\.agy-powerline\statusline.config.json`（UTF-8 无 BOM）；
5. 校验或更新 `%USERPROFILE%\.gemini\antigravity-cli\settings.json` 中的 `statusLine` 字段；
6. 运行 `npx -y agy-powerline doctor` 进行健康自检。

安装完成后，**新开或重启 `agy` 会话**即可在底部看到效果。

---

### 方式 C：手动分步安装（无 Git 或手动校验时）

1. **初始化 `agy-powerline`**：
   ```powershell
   npx -y agy-powerline@latest init --yes
   ```
2. **下载仓库中的两个核心文件**：
   - 将 [`turn-elapsed.js`](./turn-elapsed.js) 保存到：`%USERPROFILE%\.agy-powerline\turn-elapsed.js`
   - 将 [`statusline.config.json`](./statusline.config.json) 保存到：`%USERPROFILE%\.agy-powerline\statusline.config.json`
3. **修改 `statusline.config.json` 中的 `exec.cmd`**：
   - 打开 `%USERPROFILE%\.agy-powerline\statusline.config.json`，将 `exec` 挂件里的 `<YOUR_USERNAME>` 替换为当前 Windows 用户名，并确保 `node.exe` 使用无空格短路径（可用 `cmd /c for %I in ("C:\Program Files\nodejs\node.exe") do @echo %~sI` 查看，通常为 `C:\Progra~1\nodejs\node.exe`）：
     ```json
     "cmd": "C:\\Progra~1\\nodejs\\node.exe C:\\Users\\你的用户名\\.agy-powerline\\turn-elapsed.js"
     ```
     > 如果你的用户名目录也包含空格（例如 `John Doe`），请同样用 `cmd /c for %I in ("%USERPROFILE%\.agy-powerline\turn-elapsed.js") do @echo %~sI` 转成 `8.3` 短路径后填入。
4. **核对 `%USERPROFILE%\.gemini\antigravity-cli\settings.json`**：
   确保包含如下配置（正斜杠、**不要加引号**）：
   ```json
   "statusLine": {
     "type": "command",
     "command": "C:/Users/你的用户名/.agy-powerline/statusline.cmd"
   }
   ```
5. **运行自检与仿真验证**：
   ```powershell
   npx -y agy-powerline doctor
   ```
   确认看到 `spawn         ok`、`problem log   empty`，且渲染结果同时包含左 4 项与最右侧模型名。

---

## 4. Windows 关键踩坑与设计细节

以下均为实机排错总结的硬约束，修改或二次定制时请勿破坏：

1. **Windows `cmd /c` 路径与引号禁忌**：
   - `agy` CLI 在 Windows 下通过 `cmd /c` 启动 `statusLine.command` 且会转义双引号。
   - `settings.json` 中 `statusLine.command` 必须保持**无引号正斜杠路径**（如 `C:/Users/<用户名>/.agy-powerline/statusline.cmd`）；
   - `statusline.config.json` 中 `exec.cmd` 调用 `node.exe` 必须使用**无空格 `8.3` 短路径**（如 `C:\Progra~1\nodejs\node.exe`），禁止直接写带空格路径或嵌套双引号。
2. **`exec` 挂件缓存与超时参数不可改回默认值**：
   - `agy-powerline` 的 `exec` 默认 `interval` 为 `10` 秒（且磁盘缓存仅按 `cmd + cwd` 共享，不区分会话）、默认 `timeout` 为 `500ms`；
   - `turn-elapsed.js` 挂件必须保持 `"payload": true`、`"interval": 0`、`"timeout": 2000`，否则会出现秒表不实时跳动、多窗口串数据，或在 Windows 双层子进程启动（约 `400~515ms`）下频繁触发 `EXEC_TIMEOUT`。
3. **多窗口状态隔离与大日志反向分块扫描**：
   - `agy-powerline` 会在向 `exec` 传参前自动剥离 `email`、`session_id`、`conversation_id`，仅保留 `transcript_path` 与 `agent_state`；
   - `turn-elapsed.js` 按 `transcript_path` 的 SHA-1 哈希将单轮状态文件隔离在 `%TEMP%\agy-turn-elapsed\`；
   - 兜底回填时采用 `128KB/块`、上限 `4MB` 的反向分块扫描定位最后一条 `"USER_INPUT"`，避免单步工具输出超过 `40KB` 时被小范围尾部截断漏扫而显示 `--`。
4. **沙箱信任目录边界**：
   - `agy-powerline` 仅允许全局默认目录 `%USERPROFILE%\.agy-powerline`（或显式设置的 `AGY_POWERLINE_HOME`）下的配置执行 `exec` 挂件，放到其他路径会被拦截并显示 `[blocked]`。
5. **模型名称原样展示原因**：
   - 配置中 `model` 挂件启用了 `"raw": true`，用于隐藏 `🤖` 图标与 `Model:` 前缀，直接按 `agy` 原生格式展示 `Orchestrator (Argon)` 或 `Gemini 2.5 Pro (High)`。

---

## 5. 日常维护、升级与卸载

```powershell
# 1. 升级 agy-powerline 本体（会自动保留 statusline.config.json 与 turn-elapsed.js）
npx -y agy-powerline@latest init --yes

# 2. 健康检查与渲染诊断
npx -y agy-powerline doctor

# 3. 临时恢复或彻底卸载自定义状态栏
# 在 agy 对话中可随时执行：/statusline delete 或 /statusline enable
npx -y agy-powerline uninstall --yes --delete
```

> 若出现问题日志提示（`problem log` 非空），可运行 `npx -y agy-powerline report` 查看详情。
