# BMAD Claude 安装指南

## 系统要求

| 项目 | 要求 |
|------|------|
| 操作系统 | Windows 10 (1903+) / macOS 12+ |
| 架构 | x64（Windows ARM64 暂不支持） |
| 磁盘空间 | ≥ 500 MB（含依赖缓存） |

---

## 一、前置依赖（必须手动安装）

BMAD Claude 本身只是一个界面，以下工具需要提前安装好：

### 1. Node.js + npm

前往 [https://nodejs.org](https://nodejs.org) 下载 LTS 版本，安装完成后验证：

```bash
node --version   # 应输出 v18 或更高
npm --version
```

### 2. Git

- **Windows**：前往 [https://git-scm.com](https://git-scm.com) 下载安装，安装时勾选「Add Git to PATH」
- **macOS**：运行 `xcode-select --install` 或通过 Homebrew 安装 `brew install git`

验证：

```bash
git --version
```

---

## 二、安装 BMAD Claude

### Windows

1. 下载 `BMAD Claude Setup 0.1.0.exe`
2. 双击运行，出现 SmartScreen 警告时点击「更多信息」→「仍要运行」
3. 安装完成后桌面会出现快捷方式

### macOS

1. 下载 `BMAD Claude-0.1.0-mac.dmg`
2. 打开 DMG，将应用拖入「应用程序」文件夹
3. 首次启动时右键点击 → 打开（绕过 Gatekeeper）

---

## 三、首次启动配置

启动 BMAD Claude 后，点击「新建项目」或「普通任务」，应用会自动检测并引导安装所需工具。

### 3.1 Claude Code CLI（必需）

若检测到未安装，应用会自动执行：

```bash
npm install -g @anthropic-ai/claude-code
```

安装完成后需要完成 Claude Code 的登录授权，在应用内置终端中运行：

```bash
claude
```

按照提示完成 OAuth 登录。

### 3.2 All-in-One 多模型协作环境（推荐）

勾选「安装 All-in-One」后，应用会**一键完成以下全部配置**（Codex CLI 和 Gemini CLI 作为其组成部分会自动安装，无需单独操作）：

| 步骤 | 内容 |
|------|------|
| ① 安装 Codex CLI | `npm install -g @openai/codex` |
| ② 安装 Gemini CLI | `npm install -g @google/gemini-cli` |
| ③ 安装 uv / uvx | macOS 用 shell 脚本，Windows 用 PowerShell 脚本 |
| ④ 注册 MCP 服务器 | 向 `~/.claude.json` 写入 Codex 和 Gemini 的 MCP server 配置 |
| ⑤ 写入 Core Instruction | 向 `~/.claude/CLAUDE.md` 追加多模型协作规范 |

**Windows 额外步骤**（自动完成，无需手动操作）：

由于 Windows 上 uvx 存在 git 子模块兼容性问题，应用会绕过 uvx，改用：
- `git clone --no-recurse-submodules` 将 `codexmcp` 和 `geminimcp` 克隆至 `~/.bmad-claude/mcp-src/`
- 通过 `uv pip install` 安装到专属虚拟环境 `~/.bmad-claude/mcp-venv/`

> **注意**：Windows 首次安装耗时较长（约 2–5 分钟），请保持网络畅通。若再次点击安装，会自动检测 venv 是否完整，完整则直接跳过，无需等待。

---

## 四、安装产生的文件说明

```
~/.claude.json                    MCP server 注册配置
~/.claude/CLAUDE.md               多模型协作 Core Instruction
~/.bmad-claude/
  ├── data/store.json             项目历史记录
  ├── bmad-cache/<sha>/           BMAD-METHOD 工作流文件缓存（断网可用）
  ├── agents/                     Agent YAML 缓存
  ├── mcp-src/         [Windows]  MCP 包源码（git clone）
  └── mcp-venv/        [Windows]  MCP Python 虚拟环境
```

---

## 五、Windows 常见问题

### Q：启动时提示「无法加载 .ps1，因为在此系统上禁止运行脚本」

应用内置终端已配置 `-ExecutionPolicy Bypass`，此错误不影响使用。若在系统 PowerShell 中遇到此问题，执行：

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

### Q：安装 All-in-One 时长时间卡住

检查网络是否能访问 GitHub。若在国内网络环境，建议开启代理后再点击安装。

### Q：重装后 MCP 连接失败

重新点击「安装 All-in-One」按钮，应用会检测到 venv 完整则跳过安装，直接更新配置文件路径。

---

## 六、与 cc-switch 配合使用

若使用 [cc-switch](https://github.com/farion1231/cc-switch) 管理多个 AI 工具配置，需注意：

1. **保留 MCP 条目**：在 cc-switch 的 MCP 管理界面，手动添加 `codex` 和 `gemini` 为自定义 MCP server，防止切换 provider 时被覆盖。

2. **保护 CLAUDE.md**：cc-switch 编辑系统提示时，勿整体替换 `~/.claude/CLAUDE.md`，需保留 `## Core Instruction` 段落。

3. **切换 provider 后**：若 cc-switch 覆盖了 `~/.claude.json`，在 BMAD Claude 内重新点击「安装 All-in-One」可一键恢复 MCP 配置。
