import { exec } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { BrowserWindow, app, dialog, ipcMain } from "electron"
import {
  IPC,
  type BmadRole,
  type BmadInstallRequest,
  type PingRequest,
  type PtyKillRequest,
  type PtyResizeRequest,
  type PtySpawnRequest,
  type PtyWriteRequest,
  type WorkflowEventRequest,
  type WorkflowStartRequest,
  type StorageProjectItem,
} from "@bmad-claude/ipc-contracts"
import { BmadInstaller } from "@bmad-claude/bmad-registry"
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

let mainWindow: BrowserWindow | null = null

const execAsync = promisify(exec)

// 扩展 PATH：覆盖 macOS 上 Node.js / npm / Claude 的常见安装位置
const EXTENDED_PATH = [
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  path.join(os.homedir(), ".npm-global/bin"),
  path.join(os.homedir(), ".nvm/versions/node/*/bin"),
  process.env["PATH"] ?? "",
].join(path.delimiter)

// ============================================================
// HelpAI All-in-One 多模型环境（Codex+Gemini MCP + CLAUDE.md）
// 参考：https://www.helpaio.com/guides/all-in-one
// ============================================================

const USER_CLAUDE_JSON_PATH = path.join(os.homedir(), ".claude.json")
const USER_CLAUDE_MD_PATH   = path.join(os.homedir(), ".claude", "CLAUDE.md")

const MCP_CMDS = {
  codex:  "claude mcp add codex -s user --transport stdio -- uvx --from git+https://github.com/GuDaStudio/codexmcp.git codexmcp",
  gemini: "claude mcp add gemini -s user --transport stdio -- uvx --from git+https://github.com/GuDaStudio/geminimcp.git geminimcp",
}

// 追加到 ~/.claude/CLAUDE.md 的 All-in-One 核心指令内容
const ALL_IN_ONE_MD = `
## Core Instruction

Before executing any task, ensure compliance with these directives:

0. At all times, contemplate multi-model collaboration (Gemini + Codex). As chief architect, orchestrate resources per these allocations:

   **0.1** After forming preliminary analysis of user requirements:
   - First transmit original requirements and initial strategy to codex/gemini
   - Engage iterative debate to refine planning
   - Conclude only when comprehensive understanding and viable action plan exist

   **0.2** Before coding implementation, solicit code prototypes from codex/gemini (unified diff format only, no actual modifications). Use these as logical reference; rewrite for enterprise-grade readability and maintainability.

   **0.2.1** Gemini excels at frontend work and UI/component design. Context limit: 32k tokens only. Avoid backend discussions with Gemini unless explicitly requested.

   **0.2.2** Codex excels at backend logic and bug identification. Must obtain backend code prototypes leveraging its logical prowess and error correction.

   **0.3** After completing coding actions: immediately execute codex review of modifications.

   **0.4** codex/gemini outputs serve as reference only. Maintain independent critical thinking.

1. Before answering user questions, exhaustively retrieve code/files prioritizing comprehensiveness.

2. Pose multidimensional questions to clarify requirements before proceeding.

3. Carefully locate relevant code sections—avoid surplus or missing parts.

4. Assess whether collected information suffices. Iterate as needed.

5. Explain modification strategies clearly, employing judicious pseudocode where helpful.

6. Code style: consistently pursue elegance, efficiency, zero redundancy.

7. Perform needle-targeted modifications only; preserve all unrelated functionality.

8. Use English for codex/gemini collaboration; use Chinese for user communication.

--------

## Codex Tool Calling Standards

- Preserve returned SESSION_ID for continued dialogue
- Use sandbox="read-only"; request only unified diff patches
- Suitable for: backend logic, precise bug location, code review

--------

## Gemini Tool Calling Standards

- Session management: capture SESSION_ID for multi-turn dialogue
- Prohibit complex backend business logic from Gemini
- Suitable for: requirement clarification, task planning, frontend prototypes
`.trim()

// ── 通用 login shell 执行 ──
async function runLoginShell(cmd: string, timeout = 8000): Promise<{ stdout: string; stderr: string }> {
  const shell = process.env["SHELL"] ?? "/bin/zsh"
  return execAsync(`${shell} -l -c ${JSON.stringify(cmd)}`, {
    env: { ...process.env, PATH: EXTENDED_PATH },
    timeout,
  })
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

// ── 安装 uv/uvx（macOS/Linux 通用安装脚本）──
async function installUvx(): Promise<void> {
  await runLoginShell("curl -LsSf https://astral.sh/uv/install.sh | sh", 120_000)
}

// ── 检查 All-in-One 环境是否已完整配置 ──
async function checkAllInOne(): Promise<{ installed: boolean }> {
  const [mcpNames, hasCI] = await Promise.all([getRegisteredMcpNames(), hasCoreInstruction()])
  return { installed: mcpNames.has("codex") && mcpNames.has("gemini") && hasCI }
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

    // 2. 注册 MCP servers（用 getRegisteredMcpNames 合并两种来源，确保幂等）
    const existing = await getRegisteredMcpNames()
    if (!existing.has("codex"))  await runLoginShell(MCP_CMDS.codex,  120_000)
    if (!existing.has("gemini")) await runLoginShell(MCP_CMDS.gemini, 120_000)

    // 3. 追加 CLAUDE.md（已含 Core Instruction 则跳过）
    await ensureCoreInstruction()

    // 4. 最终验证
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

const BMAD_SLASH_COMMANDS: Partial<Record<BmadRole, string>> = {
  brainstorm:    "/bmad-brainstorming",
  analyst:       "/bmad-bmm-create-product-brief",
  pm:            "/bmad-bmm-create-prd",
  "ux-designer": "/bmad-bmm-create-ux-design",
  architect:     "/bmad-bmm-create-architecture",
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
  const command = BMAD_SLASH_COMMANDS[role]
  if (!command) return

  const projectPath = workflowProjectPaths.get(workflowId)
  if (!projectPath) return

  const sessionId = projectSessionMap.get(projectPath)
  if (!sessionId) {
    console.warn(`[BMAD] No PTY session for project: ${projectPath}`)
    return
  }

  console.log(`[BMAD] Activating role ${role}: ${command}`)
  // 若携带初始指令，通过 $ARGUMENTS 注入到命令模板中一次性发送
  ptyManager.write(sessionId, initialMessage ? `${command} ${initialMessage}\r` : `${command}\r`)
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

  // 通用 npm 全局安装工具函数
  const npmInstall = async (pkg: string) => {
    const shell = process.env["SHELL"] ?? "/bin/zsh"
    try {
      await execAsync(`${shell} -l -c "npm install -g ${pkg}"`, {
        env: { ...process.env, PATH: EXTENDED_PATH },
        timeout: 120_000,
      })
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
  ipcMain.handle(IPC.PTY_SPAWN, (_e, req: PtySpawnRequest) => {
    const absPath = path.resolve(req.cwd)

    // 清理旧的 sessionId 映射
    for (const [p, sid] of projectSessionMap.entries()) {
      if (sid === req.sessionId) projectSessionMap.delete(p)
    }
    projectSessionMap.set(absPath, req.sessionId)

    const session = ptyManager.spawn(req.sessionId, {
      cwd: req.cwd,
      cols: req.cols,
      rows: req.rows,
      env: req.env ? { ...process.env, ...req.env } : process.env,
    })

    console.log(`[PTY] Session spawned: ${req.sessionId} cwd=${req.cwd}`)

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

function registerStorageHandlers(): void {
  ipcMain.handle(IPC.STORAGE_LIST_PROJECTS, (): StorageProjectItem[] => {
    return storage.listProjects().map(p => ({
      id:        p.id,
      name:      p.name,
      path:      p.path,
      updatedAt: p.updatedAt,
      lastRole:  storage.getLatestRoleForProject(p.id) ?? undefined,
    }))
  })

  ipcMain.handle(IPC.STORAGE_DELETE_PROJECT, (_e, projectPath: string): void => {
    storage.deleteProject(projectPath)
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
// App 生命周期
// ============================================================

app.whenReady().then(() => {
  registerCoreHandlers()
  registerDialogHandlers()
  registerStorageHandlers()
  registerInstallerHandlers()
  registerDepHandlers()
  registerPtyHandlers()
  registerWorkflowHandlers()

  createMainWindow()
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") shutdown()
})

app.on("before-quit", shutdown)

function shutdown(): void {
  ptyManager.killAll()
  workflowManager.stopAll()
  storage.close()
  workflowProjectPaths.clear()
  projectSessionMap.clear()
  if (process.platform !== "darwin") app.quit()
}
