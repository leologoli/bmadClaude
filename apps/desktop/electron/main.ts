import { exec, execFile } from "node:child_process"
import fs from "node:fs/promises"
import fsSync from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { BrowserWindow, app, dialog, ipcMain, shell } from "electron"
import {
  IPC,
  type BmadRole,
  type BmadInstallRequest,
  type FsEntry,
  type PencilGenerateRequest,
  type PingRequest,
  type PtyKillRequest,
  type PtyResizeRequest,
  type PtySpawnRequest,
  type PtyWriteRequest,
  type WorkflowEventRequest,
  type WorkflowStartRequest,
  type StorageProjectItem,
  type StorageUpsertProjectRequest,
} from "@bmad-claude/ipc-contracts"
import { BmadInstaller } from "@bmad-claude/bmad-registry"
import { PencilBridge } from "@bmad-claude/pencil-bridge"
import { PtySessionManager } from "@bmad-claude/pty-bridge"
import { ProjectStorage } from "@bmad-claude/storage"
import { WorkflowManager } from "@bmad-claude/workflow-engine"

// ============================================================
// 单例服务
// ============================================================

const ptyManager      = new PtySessionManager()
const workflowManager = new WorkflowManager()
const storage         = new ProjectStorage()
const bmadInstaller   = new BmadInstaller()
const pencilBridge    = new PencilBridge()

let mainWindow: BrowserWindow | null = null

const execAsync     = promisify(exec)
const execFileAsync = promisify(execFile)

// 同步枚举 nvm 版本目录，获取所有 bin 路径
function getNvmBinPaths(): string[] {
  const nvmVersionsDir = path.join(os.homedir(), ".nvm", "versions", "node")

  try {
    return fsSync
      .readdirSync(nvmVersionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(nvmVersionsDir, entry.name, "bin"))
  } catch {
    return []
  }
}

// 扩展 PATH：覆盖各平台上 Node.js / npm / Claude / uv 的常见安装位置
const PLATFORM_PATH_PREFIXES = process.platform === "win32"
  ? [
    // Windows：npm 全局目录、uv 安装目录、WindowsApps（winget 安装工具）
    process.env["APPDATA"]      ? path.join(process.env["APPDATA"],      "npm")                              : "",
    process.env["LOCALAPPDATA"] ? path.join(process.env["LOCALAPPDATA"], "Programs", "uv", "bin")           : "",
    process.env["LOCALAPPDATA"] ? path.join(process.env["LOCALAPPDATA"], "Microsoft", "WindowsApps")        : "",
    path.join(os.homedir(), ".local", "bin"),
  ]
  : [
    // macOS / Linux：Homebrew、.local/bin（Claude CLI）、nvm、npm-global
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    path.join(os.homedir(), ".local/bin"),
    path.join(os.homedir(), ".npm-global/bin"),
    ...getNvmBinPaths(),
  ]

let EXTENDED_PATH = [...PLATFORM_PATH_PREFIXES, process.env["PATH"] ?? ""]
  .filter(Boolean)
  .join(path.delimiter)

// 启动时通过 login shell 加载系统 PATH（macOS/Linux 应用启动时不会加载 shell 配置）
let SYSTEM_PATH_LOADED = false

async function loadSystemPath(): Promise<void> {
  if (SYSTEM_PATH_LOADED || process.platform === "win32") return

  try {
    // 使用 printenv 避免 shell 启动脚本的输出干扰（如 banner、日志等）
    const shell = process.env["SHELL"] ?? (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash")
    const { stdout } = await execAsync(`"${shell}" -l -c 'printenv PATH'`, { timeout: 5000 })
    const systemPath = stdout.trim()

    if (systemPath && systemPath !== process.env["PATH"]) {
      console.log("[ENV] Loaded system PATH from login shell")
      process.env["PATH"] = systemPath
      // 重新构建 EXTENDED_PATH，包含系统 PATH 中的所有路径
      EXTENDED_PATH = [...PLATFORM_PATH_PREFIXES, systemPath]
        .filter(Boolean)
        .join(path.delimiter)
    }
    SYSTEM_PATH_LOADED = true
  } catch (err) {
    console.warn("[ENV] Failed to load system PATH:", err)
    SYSTEM_PATH_LOADED = true  // 避免重复尝试
  }
}

// ============================================================
// 多模型协作环境（Codex+Gemini MCP + CLAUDE.md）
// 参考：https://www.helpaio.com/guides/all-in-one
// ============================================================

const USER_CLAUDE_JSON_PATH = path.join(os.homedir(), ".claude.json")
const USER_CLAUDE_MD_PATH   = path.join(os.homedir(), ".claude", "CLAUDE.md")

const MCP_CMDS = {
  codex:  "claude mcp add codex -s user --transport stdio -- uvx --from git+https://github.com/GuDaStudio/codexmcp.git codexmcp",
  gemini: "claude mcp add gemini -s user --transport stdio -- uvx --from git+https://github.com/GuDaStudio/geminimcp.git geminimcp",
}

// Windows 专用：MCP 包的 git 仓库与 venv 脚本名称
const MCP_PACKAGES = [
  { name: "codex",  repo: "https://github.com/GuDaStudio/codexmcp.git",  script: "codexmcp"  },
  { name: "gemini", repo: "https://github.com/GuDaStudio/geminimcp.git", script: "geminimcp" },
] as const

// Windows 专用：MCP venv 与源码目录（持久化，安装一次即可）
const MCP_VENV_DIR = path.join(os.homedir(), ".bmad-claude", "mcp-venv")
const MCP_SRC_DIR  = path.join(os.homedir(), ".bmad-claude", "mcp-src")

// 追加到 ~/.claude/CLAUDE.md 的 All-in-One 核心指令内容
const ALL_IN_ONE_MD = `
## Core Instruction

在开始**任何动作或对话**前，你必须保证自己遵循了如下**Core Instruction**：

0. 在任何时刻，必须思考当前过程可以如何进行**多模型协作**（Gemini + Codex）。你作为主架构师，必须根据以下分工调度资源，以保障客观全面：

   **0.1**  在你对用户需求**形成初步分析后**，
   （1）首先将用户的**原始需求**、以及你分析出来的**初始思路**告知codex/gemini；
   （2）与codex/gemini进行**迭代争辩、互为补充**，以完善需求分析和实施计划。
   （3）0.1的终止条件为，**必须**确保对用户需求的透彻理解，并生成切实可行的行动计划。

   **0.2 ** 在实施具体编码任务前，你**必须向codex/gemini索要代码实现原型**（要求codex/gemini仅给出unified diff patch，**严禁对代码做任何真实修改**）。在获取代码原型后，你**只能以此为逻辑参考，再次对代码修改进行重写**，形成企业生产级别、可读性极高、可维护性极高的代码后，才能实施具体编程修改任务。

     **0.2.1** Gemini 十分擅长前端代码，并精通样式、UI组件设计。
     - 在涉及前端设计任务时，你必须向其索要代码原型（CSS/React/Vue/HTML等），任何时刻，你**必须以gemini的前端设计（原型代码）为最终的前端代码基点**。
     - 例如，当你识别到用户给出了前端设计需求，你的首要行为必须自动调整为，将用户需求原封不动转发给gemini，并让其出具代码示例（此阶段严禁对用户需求进行任何改动、简写等等）。即你必须从gemini获取代码基点，才可以进行接下来的各种行为。
     - gemini有**严重的后端缺陷**，在非用户指定时，严禁与gemini讨论后端代码！
     - gemini上下文有效长度**仅为32k**，请你时刻注意！

      **0.2.2** Codex十分擅长后端代码，并精通逻辑运算、Bug定位。
      - 在涉及后端代码时，你必须向其索要代码原型，以利用其强大的逻辑与纠错能力。

   **0.3** 无论何时，只要完成切实编码行为后，**必须立即使用codex review代码改动和对应需求完成程度**。
   **0.4** codex/gemini只能给出参考，你**必须有自己的思考，并时刻保持对codex/gemini回答的置疑**。必须时刻为需求理解、代码编写与审核做充分、详尽、夯实的**讨论**！

1. 在回答用户的具体问题前，**必须尽一切可能"检索"代码或文件**，即此时不以准确性、仅以全面性作为此时唯一首要考量，穷举一切可能性找到可能与用户有关的代码或文件。

2. 在获取了全面的代码或文件检索结果后，你必须不断提问以明确用户的需求。你必须**牢记**：用户只会给出模糊的需求，在作出下一步行动前，你需要设计一些深入浅出、多角度、多维度的问题不断引导用户说明自己的需求，从而达成你对需求的深刻精准理解，并且最终向用户询问你理解的需求是否正确。

3. 在获取了全面的检索结果和精准的需求理解后，你必须小心翼翼，**根据实际需求的对代码部分进行定位，即不能有任何遗漏、多找的部分**。

4. 经历以上过程后，**必须思考**你当前获得的信息是否足够进行结论或实践。如果不够的话，是否需要从项目中获取更多的信息，还是以问题的形式向用户进行询问。循环迭代1-3步骤。

5. 对制定的修改计划进行详略得当、一针见血的讲解，并善于使用**适度的伪代码**为用户讲解修改计划。

6. 整体代码风格**始终定位**为，精简高效、毫无冗余。该要求同样适用于注释与文档，且对于这两者，**非必要不形成**。

7. **仅对需求做针对性改动**，严禁影响用户现有的其他功能。

8. 使用英文与codex/gemini协作，使用中文与用户交流。

--------

## codex 工具调用规范

1. 工具概述

  codex MCP 提供了一个工具 \`codex\`，用于执行 AI 辅助的编码任务（侧重逻辑、后端、Debug）。该工具**通过 MCP 协议调用**。

2. 使用方式与规范

  **必须遵守**：
  - 每次调用 codex 工具时，必须保存返回的 SESSION_ID，以便后续继续对话
  - 严禁codex对代码进行实际修改，使用 sandbox="read-only" 以避免意外，并要求codex仅给出unified diff patch即可

  **擅长场景**：
  - **后端逻辑**实现与重构
  - **精准定位**：在复杂代码库中快速定位问题所在
  - **Debug 分析**：分析错误信息并提供修复方案
  - **代码审查**：对代码改动进行全面逻辑 review

--------

## gemini 工具调用规范

1. 工具概述

  gemini MCP 提供了一个工具 \`gemini\`，用于调用 Google Gemini 模型执行 AI 任务。该工具拥有极强的前端审美、任务规划与需求理解能力，但在**上下文长度（Effective 32k）**上有限制。

2. 使用方式与规范

  **必须遵守的限制**：
  - **会话管理**：捕获返回的 \`SESSION_ID\` 用于多轮对话。
  - **后端避让**：严禁让 Gemini 编写复杂的后端业务逻辑代码。

  **擅长场景（必须优先调用 Gemini）**：
  - **需求清晰化**：在任务开始阶段辅助生成引导性问题。
  - **任务规划**：生成 Step-by-step 的实施计划。
  - **前端原型**：编写 CSS、HTML、UI 组件代码，调整样式风格。

--------

## serena 工具调用规范

1. 在决定调用serena任何工具前，**必须**检查，是否已经使用"mcp__serena__activate_project"工具完成项目激活。

2. 善于使用serena提供的以下工具，帮助自己完成**"检索"**和**"定位"**任务。

3. 严禁使用serena工具对代码文件进行修改。你被允许使用的serena工具如下，其他**未被提及的serena工具严禁使用**。

   \`\`\`json
   ["mcp__serena__activate_project",
     "mcp__serena__check_onboarding_performed",
     "mcp__serena__delete_memory",
     "mcp__serena__find_referencing_code_snippets",
     "mcp__serena__find_referencing_symbols",
     "mcp__serena__find_symbol",
     "mcp__serena__get_current_config",
     "mcp__serena__get_symbols_overview",
     "mcp__serena__list_dir",
     "mcp__serena__list_memories",
     "mcp__serena__onboarding",
     "mcp__serena__prepare_for_new_conversation",
     "mcp__serena__read_file",
     "mcp__serena__read_memory",
     "mcp__serena__search_for_pattern",
     "mcp__serena__summarize_changes",
     "mcp__serena__switch_modes",
     "mcp__serena__think_about_collected_information",
     "mcp__serena__think_about_task_adherence",
     "mcp__serena__think_about_whether_you_are_done",
     "mcp__serena__write_memory",
     "mcp__serena__find_file"]
   \`\`\`

`.trim()

// ── 通用 shell 执行（跨平台）──
async function runLoginShell(cmd: string, timeout = 8000): Promise<{ stdout: string; stderr: string }> {
  const env = { ...process.env, PATH: EXTENDED_PATH }
  if (process.platform === "win32") {
    // Windows：cmd.exe 执行命令字符串
    const comSpec = process.env["ComSpec"] ?? process.env["COMSPEC"] ?? "cmd.exe"
    return execAsync(`"${comSpec}" /d /s /c ${JSON.stringify(cmd)}`, { env, timeout })
  }
  // macOS / Linux：login shell 确保 .zshrc/.zprofile 中的 PATH 生效
  const shell = process.env["SHELL"] ?? "/bin/zsh"
  return execAsync(`"${shell}" -l -c ${JSON.stringify(cmd)}`, { env, timeout })
}

// ── 从 ~/.claude.json 读取已注册的 MCP server 名称（-s user 安装写此文件）──
async function readUserMcpNames(): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(USER_CLAUDE_JSON_PATH, "utf-8")
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> }
    if (parsed.mcpServers && typeof parsed.mcpServers === "object") {
      return new Set(Object.keys(parsed.mcpServers))
    }
  } catch { /* 文件不存在或 JSON 损坏，均视为未配置 */ }
  return new Set()
}

// ── 解析 `claude mcp list` stdout，提取 server 名称（只解析 stdout，避免 stderr 干扰）──
function parseMcpListNames(stdout: string): Set<string> {
  const names = new Set<string>()
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9._-]+)\s*:/)
    if (m) names.add(m[1])
  }
  return names
}

// ── 合并两种来源，获取完整已注册 MCP 名称集合 ──
async function getRegisteredMcpNames(): Promise<Set<string>> {
  const fromConfig = await readUserMcpNames()
  // 若配置文件已包含两者则直接返回，避免执行较慢的 `claude mcp list`
  if (fromConfig.has("codex") && fromConfig.has("gemini")) return fromConfig
  try {
    const { stdout } = await runLoginShell("claude mcp list", 15_000)
    for (const name of parseMcpListNames(stdout)) fromConfig.add(name)
  } catch { /* claude 未安装或超时，保持已有结果 */ }
  return fromConfig
}

// ── 检查 ~/.claude/CLAUDE.md 是否已包含 Core Instruction 段 ──
async function hasCoreInstruction(): Promise<boolean> {
  try {
    const content = await fs.readFile(USER_CLAUDE_MD_PATH, "utf-8")
    return /^\s*##\s+Core Instruction\b/m.test(content)
  } catch { return false }
}

// ── 检查 uvx 是否可用（MCP server 运行依赖）──
async function checkUvx(): Promise<boolean> {
  try {
    await runLoginShell("uvx --version", 8000)
    return true
  } catch { return false }
}

// ── 安装 uv/uvx（跨平台）──
async function installUvx(): Promise<void> {
  if (process.platform === "win32") {
    // Windows：直接调用 powershell.exe + 数组参数，规避 cmd.exe 双引号转义问题
    await execFileAsync("powershell", [
      "-NoLogo", "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-Command", "irm https://astral.sh/uv/install.ps1 | iex",
    ], { env: { ...process.env, PATH: EXTENDED_PATH }, timeout: 120_000 })
    return
  }
  // macOS / Linux：通过 sh 执行官方 shell 安装脚本
  await runLoginShell("curl -LsSf https://astral.sh/uv/install.sh | sh", 120_000)
}

// ── 检查 All-in-One 环境是否已完整配置 ──
async function checkAllInOne(): Promise<{ installed: boolean }> {
  const [mcpNames, hasCI] = await Promise.all([getRegisteredMcpNames(), hasCoreInstruction()])
  return { installed: mcpNames.has("codex") && mcpNames.has("gemini") && hasCI }
}

// ── Windows：克隆 MCP 包（跳过子模块）并安装到专属 venv ──
// uvx --from git+https://... 会执行 git submodule update，在部分 Windows 环境失败；
// 改用 git clone --no-recurse-submodules + uv pip install 本地目录，完全绕开子模块问题
async function installMcpVenvWindows(): Promise<void> {
  if (process.platform !== "win32") return

  const pythonExe = path.join(MCP_VENV_DIR, "Scripts", "python.exe")
  const scriptExes = MCP_PACKAGES.map(p => path.join(MCP_VENV_DIR, "Scripts", `${p.script}.exe`))

  // 检查 venv 是否完整：python.exe + 全部 MCP 脚本都存在则跳过
  const checks = await Promise.all(
    [pythonExe, ...scriptExes].map(f => fs.access(f).then(() => true).catch(() => false))
  )
  if (checks.every(Boolean)) {
    console.log("[MCP] Windows venv already complete, skipping reinstall")
    return
  }

  // 有任意文件缺失：清理旧环境，全量重建
  const env = { ...process.env, PATH: EXTENDED_PATH }
  await fs.rm(MCP_SRC_DIR,  { recursive: true, force: true }).catch(() => {})
  await fs.rm(MCP_VENV_DIR, { recursive: true, force: true }).catch(() => {})
  await fs.mkdir(MCP_SRC_DIR, { recursive: true })

  // 1. 逐个克隆（无子模块）
  for (const pkg of MCP_PACKAGES) {
    const dest = path.join(MCP_SRC_DIR, pkg.name)
    await execAsync(`git clone --no-recurse-submodules "${pkg.repo}" "${dest}"`, { env, timeout: 120_000 })
    console.log(`[MCP] Cloned ${pkg.name} to ${dest}`)
  }

  // 2. 创建 venv
  await execAsync(`uv venv "${MCP_VENV_DIR}"`, { env, timeout: 30_000 })

  // 3. 将所有包安装进 venv
  const srcPaths = MCP_PACKAGES.map(p => `"${path.join(MCP_SRC_DIR, p.name)}"`).join(" ")
  await execAsync(`uv pip install ${srcPaths} --python "${pythonExe}"`, { env, timeout: 120_000 })
  console.log("[MCP] Packages installed to venv")
}

// ── Windows：将 ~/.claude.json 中 MCP server 的 command 替换为 venv 内的可执行文件 ──
async function patchMcpEnvForWindows(): Promise<void> {
  if (process.platform !== "win32") return

  try {
    const raw  = await fs.readFile(USER_CLAUDE_JSON_PATH, "utf-8")
    const json = JSON.parse(raw) as {
      mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>
    }
    if (!json.mcpServers) return

    let patched = false
    for (const pkg of MCP_PACKAGES) {
      if (json.mcpServers[pkg.name]) {
        // 用 venv 中安装的脚本直接执行，不再依赖 uvx + git submodule
        json.mcpServers[pkg.name].command = path.join(MCP_VENV_DIR, "Scripts", `${pkg.script}.exe`)
        json.mcpServers[pkg.name].args    = []
        json.mcpServers[pkg.name].env     = { PATH: EXTENDED_PATH }
        patched = true
      }
    }
    if (patched) await fs.writeFile(USER_CLAUDE_JSON_PATH, JSON.stringify(json, null, 2) + "\n", "utf-8")
    console.log("[MCP] Windows venv patch applied")
  } catch { /* 文件不存在或 JSON 损坏，跳过 */ }
}

// ── 幂等地追加 Core Instruction 到 CLAUDE.md ──
async function ensureCoreInstruction(): Promise<void> {
  if (await hasCoreInstruction()) return
  let current = ""
  try { current = await fs.readFile(USER_CLAUDE_MD_PATH, "utf-8") } catch { /* 文件不存在 */ }
  await fs.mkdir(path.dirname(USER_CLAUDE_MD_PATH), { recursive: true })
  const sep = current.endsWith("\n") ? "\n" : "\n\n"
  await fs.appendFile(USER_CLAUDE_MD_PATH, `${current ? sep : ""}${ALL_IN_ONE_MD}\n`, "utf-8")
}

// ── 安装 All-in-One 环境（幂等：已注册/已配置的步骤自动跳过）──
async function installAllInOne(): Promise<{ ok: boolean; error?: string }> {
  try {
    // 1. 确保 uvx 可用（MCP server 运行依赖）
    const hasUvx = await checkUvx()
    if (!hasUvx) await installUvx()

    // 2. 注册 MCP servers（claude mcp add 仅写配置，不实际运行 uvx）
    const existing = await getRegisteredMcpNames()
    if (!existing.has("codex"))  await runLoginShell(MCP_CMDS.codex,  120_000)
    if (!existing.has("gemini")) await runLoginShell(MCP_CMDS.gemini, 120_000)

    // 3. Windows：克隆 MCP 包（跳过子模块）并安装到专属 venv
    await installMcpVenvWindows()

    // 4. Windows：将 ~/.claude.json 中的命令替换为 venv 脚本路径
    await patchMcpEnvForWindows()

    // 5. 追加 CLAUDE.md（已含 Core Instruction 则跳过）
    await ensureCoreInstruction()

    // 6. 最终验证
    const result = await checkAllInOne()
    if (!result.installed) return { ok: false, error: "安装完成但验证未通过，请检查 claude CLI 是否正常" }
    return { ok: true }
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// 工作流 ID → 项目路径（用于角色激活）
const workflowProjectPaths = new Map<string, string>()
// 项目路径（绝对路径）→ sessionId（用于向 PTY 发送 BMAD slash command）
const projectSessionMap    = new Map<string, string>()

// ============================================================
// BMAD 角色 → Claude Code 斜杠命令映射
// 命令由 `npx bmad-method install --tools claude-code` 安装到项目的 .claude/commands/
// ============================================================

const BMAD_SLASH_COMMANDS: Partial<Record<BmadRole, string | string[]>> = {
  brainstorm:    "/bmad-brainstorming",
  analyst:       "/bmad-bmm-create-product-brief",
  pm:            "/bmad-bmm-create-prd",
  "ux-designer": "/bmad-bmm-create-ux-design",
  architect:     "/bmad-bmm-create-architecture",
  "epic-planner": ["/bmad-create-epics-and-stories", "/bmad-check-implementation-readiness"],
  developer:     "/bmad-bmm-dev-story",
  qa:            "/bmad-bmm-qa-generate-e2e-tests",
}

// ============================================================
// 主窗口
// ============================================================

function createMainWindow(): BrowserWindow {
  // dev 模式下 build/icon.png 存在；打包后系统从 .icns 读取，无需再设
  const iconPath = path.join(app.getAppPath(), "build", "icon.png")

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#1e1e2e",
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  // macOS Dock 图标（仅 dev 有效；打包后系统自动读取 .icns）
  if (process.platform === "darwin") {
    try { app.dock.setIcon(iconPath) } catch { /* 忽略路径不存在的情况 */ }
  }

  if (process.env["ELECTRON_RENDERER_URL"]) {
    void mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"])
    mainWindow.webContents.openDevTools()
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"))
  }

  mainWindow.on("closed", () => { mainWindow = null })
  return mainWindow
}

// ============================================================
// BMAD 角色激活：向 PTY 发送对应的 BMAD slash command
// ============================================================

function activateBmadRole(workflowId: string, role: BmadRole, initialMessage?: string): void {
  const commands = BMAD_SLASH_COMMANDS[role]
  if (!commands) return

  const projectPath = workflowProjectPaths.get(workflowId)
  if (!projectPath) return

  const sessionId = projectSessionMap.get(projectPath)
  if (!sessionId) {
    console.warn(`[BMAD] No PTY session for project: ${projectPath}`)
    return
  }

  // 支持单个命令或命令数组
  const cmdList = Array.isArray(commands) ? commands : [commands]

  console.log(`[BMAD] Activating role ${role}: ${cmdList.join(" → ")}`)

  // 依次发送命令，中间加入短暂延迟确保前一条执行完成
  cmdList.forEach((cmd, index) => {
    setTimeout(() => {
      const data = initialMessage && index === 0
        ? `${cmd} ${initialMessage}\r`
        : `${cmd}\r`
      ptyManager.write(sessionId, data)
    }, index * 500)  // 每条命令间隔 500ms
  })
}

// ============================================================
// IPC 注册
// ============================================================

// ── 检查单个命令是否可用（login shell 执行，确保 .zshrc/.zprofile 中的 PATH 生效）──
async function checkDep(cmd: string): Promise<{ installed: boolean; version?: string }> {
  try {
    const { stdout } = await runLoginShell(cmd)
    return { installed: true, version: stdout.trim().split(/\r?\n/)[0] }
  } catch {
    return { installed: false }
  }
}

function registerDepHandlers(): void {
  // 并行检查所有依赖（必需 + 可选 + uvx + All-in-One 环境）
  ipcMain.handle(IPC.DEP_CHECK, async () => {
    const [node, npm, claude, codex, gemini, uvxOk, allInOne] = await Promise.all([
      checkDep("node --version"),
      checkDep("npm --version"),
      checkDep("claude --version"),
      checkDep("codex --version"),
      checkDep("gemini --version"),
      checkUvx().then(ok => ({ installed: ok })),
      checkAllInOne(),
    ])
    return { node, npm, claude, codex, gemini, uvx: uvxOk, allInOne }
  })

  // 通用 npm 全局安装工具函数（复用 runLoginShell 保证跨平台一致性）
  const npmInstall = async (pkg: string) => {
    try {
      await runLoginShell(`npm install -g ${pkg}`, 120_000)
      return { ok: true }
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  ipcMain.handle(IPC.DEP_INSTALL_CLAUDE,     async () => npmInstall("@anthropic-ai/claude-code"))
  ipcMain.handle(IPC.DEP_INSTALL_CODEX,      async () => npmInstall("@openai/codex"))
  ipcMain.handle(IPC.DEP_INSTALL_GEMINI,     async () => npmInstall("@google/gemini-cli"))
  ipcMain.handle(IPC.DEP_INSTALL_ALL_IN_ONE, async () => installAllInOne())
}

function registerCoreHandlers(): void {
  ipcMain.handle(IPC.PING, (_e, req: PingRequest) => ({
    message: `pong:${req.message}`,
    timestamp: Date.now(),
  }))
}

function registerInstallerHandlers(): void {
  ipcMain.handle(IPC.BMAD_INSTALL, async (_e, req: BmadInstallRequest) => {
    const absPath     = path.resolve(req.projectPath.trim())
    const projectName = req.projectName ?? path.basename(absPath)

    // 目录不存在时自动创建
    await fs.mkdir(absPath, { recursive: true })

    // 直接从 GitHub 下载 BMAD-METHOD 工作流文件，无需 npx
    const result = await bmadInstaller.install(absPath, projectName)
    return {
      ok:     result.ok,
      error:  result.error,
      stdout: "",
      stderr: "",
    }
  })

  // 仅重新生成命令文件，无需网络（修复版本更新后命令缺失）
  ipcMain.handle(IPC.BMAD_REPAIR_COMMANDS, async (_e, req: BmadInstallRequest) => {
    const absPath = path.resolve(req.projectPath.trim())
    const result  = await bmadInstaller.repairCommands(absPath)
    return { ok: result.ok, error: result.error, stdout: "", stderr: "" }
  })
}

function registerPtyHandlers(): void {
  ipcMain.handle(IPC.PTY_SPAWN, async (_e, req: PtySpawnRequest) => {
    const absPath = path.resolve(req.cwd)

    // 目录不存在时自动创建（支持多级路径）
    await fs.mkdir(absPath, { recursive: true })

    // 清理旧的 sessionId 映射
    for (const [p, sid] of projectSessionMap.entries()) {
      if (sid === req.sessionId) projectSessionMap.delete(p)
    }
    projectSessionMap.set(absPath, req.sessionId)

    // 构建环境变量：确保 PATH 不被 req.env 覆盖
    const merged = req.env
      ? {
        ...process.env,
        PATH: EXTENDED_PATH,
        // Windows 环境变量键大小写不敏感，需移除所有 PATH 变体
        ...Object.fromEntries(Object.entries(req.env).filter(([k]) => !/^path$/i.test(k))),
      }
      : { ...process.env, PATH: EXTENDED_PATH }

    // process.env 的类型包含 undefined 值，node-pty native 层收到 undefined 会触发 posix_spawnp EINVAL
    const finalEnv = Object.fromEntries(
      Object.entries(merged).filter((e): e is [string, string] => e[1] != null)
    )

    const session = ptyManager.spawn(req.sessionId, {
      cwd: absPath,  // 使用规范化的绝对路径
      cols: req.cols,
      rows: req.rows,
      env: finalEnv,
    })

    console.log(`[PTY] Session spawned: ${req.sessionId} cwd=${absPath}`)

    // PTY 输出 → 渲染进程（实时流）
    let firstData = true
    session.onData((data) => {
      if (firstData) {
        console.log(`[PTY] First output from session ${req.sessionId}`)
        firstData = false
      }
      mainWindow?.webContents.send(IPC.PTY_DATA, { sessionId: req.sessionId, data })
    })

    // PTY 退出 → 清理
    session.onExit((exitCode, signal) => {
      mainWindow?.webContents.send(IPC.PTY_EXIT, { sessionId: req.sessionId, exitCode, signal })
      for (const [p, sid] of projectSessionMap.entries()) {
        if (sid === req.sessionId) projectSessionMap.delete(p)
      }
      ptyManager.kill(req.sessionId)
    })
  })

  ipcMain.handle(IPC.PTY_WRITE,  (_e, req: PtyWriteRequest)  => { ptyManager.write(req.sessionId, req.data) })
  ipcMain.handle(IPC.PTY_RESIZE, (_e, req: PtyResizeRequest) => { ptyManager.resize(req.sessionId, req.cols, req.rows) })
  ipcMain.handle(IPC.PTY_KILL,   (_e, req: PtyKillRequest)   => {
    for (const [p, sid] of projectSessionMap.entries()) {
      if (sid === req.sessionId) projectSessionMap.delete(p)
    }
    ptyManager.kill(req.sessionId)
  })
}

function registerDialogHandlers(): void {
  ipcMain.handle(IPC.DIALOG_OPEN_DIR, async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ["openDirectory"],
      title: "选择项目目录",
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
}

function registerFsHandlers(): void {
  // 列出单层目录内容（懒加载，点击展开时调用）
  ipcMain.handle(IPC.FS_LIST_DIR, async (_e, dirPath: string): Promise<FsEntry[]> => {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true })
      return entries
        .filter(e => !e.name.startsWith("."))   // 隐藏文件默认不显示
        .map(e => ({
          name:  e.name,
          path:  path.join(dirPath, e.name),
          isDir: e.isDirectory(),
        }))
        .sort((a, b) => {
          // 文件夹优先，再按名称字母序
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
          return a.name.localeCompare(b.name)
        })
    } catch {
      return []
    }
  })
}

function registerStorageHandlers(): void {
  ipcMain.handle(IPC.STORAGE_LIST_PROJECTS, (): StorageProjectItem[] => {
    return storage.listProjects().map(p => ({
      id:        p.id,
      name:      p.name,
      path:      p.path,
      updatedAt: p.updatedAt,
      isPlain:   p.isPlain,
      lastRole:  storage.getLatestRoleForProject(p.id) ?? undefined,
    }))
  })

  ipcMain.handle(IPC.STORAGE_DELETE_PROJECT, (_e, projectPath: string): void => {
    storage.deleteProject(projectPath)
  })

  ipcMain.handle(IPC.STORAGE_UPSERT_PROJECT, (_e, req: StorageUpsertProjectRequest): void => {
    const now = Date.now()
    storage.createProject({ id: req.id, name: req.name, path: req.path, isPlain: req.isPlain, createdAt: now, updatedAt: now })
  })
}

function registerWorkflowHandlers(): void {
  ipcMain.handle(IPC.WORKFLOW_START, async (_e, req: WorkflowStartRequest) => {
    const absPath = path.resolve(req.projectPath)

    const snapshot = workflowManager.start(
      req.workflowId, req.projectName, req.projectPath, req.initialRole,
    )
    workflowProjectPaths.set(req.workflowId, absPath)

    storage.createProject({
      id: req.workflowId, name: req.projectName, path: absPath,
      createdAt: Date.now(), updatedAt: Date.now(),
    })
    storage.upsertWorkflowSnapshot(req.workflowId, req.workflowId, snapshot)

    mainWindow?.webContents.send(IPC.WORKFLOW_SNAPSHOT, snapshot)
    return snapshot
  })

  ipcMain.handle(IPC.WORKFLOW_EVENT, async (_e, req: WorkflowEventRequest) => {
    const snapshot = workflowManager.sendEvent(req.workflowId, req.event)
    if (!snapshot) return null

    storage.upsertWorkflowSnapshot(req.workflowId, req.workflowId, snapshot)
    mainWindow?.webContents.send(IPC.WORKFLOW_SNAPSHOT, snapshot)

    // 角色切换时发送对应的 BMAD slash command
    if (req.event.type === "SWITCH_ROLE") {
      // SWITCH_ROLE 可携带 initialMessage，通过 $ARGUMENTS 注入到命令中
      activateBmadRole(req.workflowId, snapshot.currentRole, req.event.initialMessage)
    } else if (req.event.type === "NEXT") {
      activateBmadRole(req.workflowId, snapshot.currentRole)
    }

    return snapshot
  })
}

// ============================================================
// Pencil.dev 处理器
// ============================================================

function registerPencilHandlers(): void {
  // 检测 Pencil CLI 是否已安装
  ipcMain.handle(IPC.PENCIL_CHECK, async () => {
    return pencilBridge.checkInstalled()
  })

  // 生成 UX 交互原型（自动发现 UX 规格文件，调用 Pencil CLI）
  ipcMain.handle(IPC.PENCIL_GENERATE, async (_e, req: PencilGenerateRequest) => {
    // 基础参数校验
    const projectPath = typeof req?.projectPath === "string" ? req.projectPath.trim() : ""
    if (!projectPath) return { ok: false, error: "projectPath 不能为空" }
    const model = typeof req?.model === "string" && req.model.trim() ? req.model.trim() : undefined

    try {
      const result = await pencilBridge.generatePrototype({ projectPath, model })
      return { ok: true, penPath: result.penPath }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      console.error("[Pencil] generatePrototype failed:", error)
      return { ok: false, error }
    }
  })
}

// ============================================================
// Shell 工具处理器
// ============================================================

function registerShellHandlers(): void {
  // 使用系统默认应用打开文件（静态 import，无动态加载开销）
  ipcMain.handle(IPC.SHELL_OPEN_PATH, async (_e, filePath: string) => {
    // 仅允许绝对路径，防止意外打开 URL 或相对路径
    if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
      throw new Error("filePath 必须是绝对路径")
    }
    const openErr = await shell.openPath(filePath)
    if (openErr) throw new Error(openErr)
  })
}

// ============================================================
// App 生命周期
// ============================================================

app.whenReady().then(async () => {
  // 启动时加载系统 PATH（确保 PTY 能访问 shell 配置的所有命令）
  await loadSystemPath()

  registerCoreHandlers()
  registerDialogHandlers()
  registerFsHandlers()
  registerStorageHandlers()
  registerInstallerHandlers()
  registerDepHandlers()
  registerPtyHandlers()
  registerPencilHandlers()
  registerShellHandlers()
  registerWorkflowHandlers()

  createMainWindow()
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on("window-all-closed", () => {
  // macOS 关闭最后一个窗口不退出应用，其他平台直接退出
  if (process.platform !== "darwin") app.quit()
})

// before-quit 在任何平台退出前都会触发，统一在此做资源清理
app.on("before-quit", shutdown)

function shutdown(): void {
  ptyManager.killAll()
  workflowManager.stopAll()
  storage.close()
  workflowProjectPaths.clear()
  projectSessionMap.clear()
}
