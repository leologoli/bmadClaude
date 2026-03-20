import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

// Pencil.dev 支持的 AI 模型（最新最强版本）
const DEFAULT_MODEL     = "claude-4.6-opus"
// CLI 在打开 Pencil.dev GUI 后即返回，30 秒足够
const CLI_TIMEOUT_MS    = 30_000
const PEN_FILENAME      = "ux-prototype.pen"
const CONFIG_FILENAME   = "pencil-agent-config.json"

// Pencil.dev .pen 格式要求：文件必须预先存在，且包含合法的初始画布
const MINIMAL_PEN_DOC = {
  version: "1",
  children: [
    {
      id:       "screen-1",
      type:     "frame",
      name:     "UX Prototype",
      width:    1440,
      height:   900,
      fill:     "#1e1e2e",
      children: [],
    },
  ],
}

// ============================================================
// 导出类型（同步到 ipc-contracts 中使用）
// ============================================================

export interface PencilCheckResult {
  installed:   boolean
  binaryPath?: string
  version?:    string
  error?:      string
}

export interface GeneratePrototypeInput {
  projectPath: string
  model?:      string   // 默认 claude-4.6-opus
}

export interface GeneratePrototypeResult {
  penPath:    string   // 生成的 .pen 文件路径
  configPath: string   // 生成的 agent config 路径
}

// Pencil CLI agent-config 格式（JSON 数组）
interface AgentConfigItem {
  file:          string
  prompt:        string
  model:         string
  attachments?:  string[]
}

// ============================================================
// PencilBridge：封装 Pencil CLI 的检测与调用
// ============================================================

export class PencilBridge {
  /** 检测 Pencil CLI 是否已安装并可用 */
  async checkInstalled(): Promise<PencilCheckResult> {
    const binaryPath = await resolvePencilBinary()
    if (!binaryPath) {
      return {
        installed: false,
        error: "未找到 pencil 命令。请在 Pencil.dev 中执行 File → Install pencil command into PATH。",
      }
    }

    try {
      const { stdout } = await execFileAsync(binaryPath, ["--version"], { timeout: 5_000 })
      const version = stdout.trim().split(/\r?\n/)[0]
      return { installed: true, binaryPath, version: version || undefined }
    } catch {
      // --version 可能不被所有版本支持，binary 存在即视为已安装
      return { installed: true, binaryPath }
    }
  }

  /**
   * 生成 UX 交互原型：
   * 1. 自动查找项目内的 UX 规格 markdown 文件
   * 2. 创建合法的空白 .pen 文件（Pencil CLI 要求预先存在）
   * 3. 写入 pencil-agent-config.json（附带 UX 规格作为 attachment）
   * 4. 调用 `pencil --agent-config`，Pencil.dev 自动打开并由 AI 执行设计
   */
  async generatePrototype(input: GeneratePrototypeInput): Promise<GeneratePrototypeResult> {
    const check = await this.checkInstalled()
    if (!check.installed || !check.binaryPath) {
      throw new Error(check.error ?? "Pencil CLI 未安装")
    }

    const projectPath = path.resolve(input.projectPath)
    const outputDir   = path.join(projectPath, "_bmad-output", "prototypes", "ux")
    await fs.mkdir(outputDir, { recursive: true })

    // 确保 .pen 文件预先存在（已有则不覆盖，保留上次编辑内容）
    const penPath = path.join(outputDir, PEN_FILENAME)
    await ensurePenFile(penPath)

    // 自动查找 UX 规格文档
    const uxSpecPath = await findUxSpecFile(projectPath)

    // 构建并写入 agent config（JSON 数组格式）
    const configPath = path.join(outputDir, CONFIG_FILENAME)
    const configItem: AgentConfigItem = {
      file:   penPath,
      prompt: buildDesignPrompt(uxSpecPath),
      model:  input.model ?? DEFAULT_MODEL,
    }
    if (uxSpecPath) configItem.attachments = [uxSpecPath]
    await fs.writeFile(configPath, JSON.stringify([configItem], null, 2), "utf-8")

    // 调用 Pencil CLI（打开 Pencil.dev GUI 并启动 AI 设计，CLI 本身快速返回）
    try {
      await execFileAsync(
        check.binaryPath,
        ["--agent-config", configPath],
        { cwd: outputDir, timeout: CLI_TIMEOUT_MS, windowsHide: true },
      )
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { killed?: boolean }
      if (e.killed) throw new Error(`Pencil CLI 调用超时（>${CLI_TIMEOUT_MS / 1000}s）`)
      throw err
    }

    return { penPath, configPath }
  }
}

// ============================================================
// 内部工具函数
// ============================================================

/** 确保 .pen 文件存在，若不存在则写入最小合法文档 */
async function ensurePenFile(penPath: string): Promise<void> {
  try {
    await fs.access(penPath)
  } catch {
    await fs.writeFile(penPath, JSON.stringify(MINIMAL_PEN_DOC, null, 2), "utf-8")
  }
}

/**
 * 在项目目录中查找最相关的 UX 规格 markdown 文件：
 * 优先搜索 _bmad-output/planning-artifacts/，按关键词匹配
 */
async function findUxSpecFile(projectPath: string): Promise<string | null> {
  const searchDirs = [
    path.join(projectPath, "_bmad-output", "planning-artifacts"),
    path.join(projectPath, "_bmad-output"),
    projectPath,
  ]
  const uxKeywords = ["ux", "design", "wireframe", "interface", "ui"]

  for (const dir of searchDirs) {
    try {
      const entries = await fs.readdir(dir)
      const mdFiles = entries.filter(f => f.endsWith(".md"))
      const match   = mdFiles.find(f => uxKeywords.some(k => f.toLowerCase().includes(k)))
      if (match) return path.join(dir, match)
    } catch {
      // 目录不存在，跳过
    }
  }
  return null
}

/** 构建发送给 Pencil AI 的设计提示词 */
function buildDesignPrompt(uxSpecPath: string | null): string {
  const base = [
    "Design a complete interactive UI prototype with multiple screens.",
    "Create realistic UI components, proper navigation flows, and ensure all screens are interconnected.",
    "Use modern design principles: clear visual hierarchy, consistent spacing, and accessible color contrast.",
  ].join(" ")

  return uxSpecPath
    ? `${base} Follow all requirements and specifications from the attached UX spec document.`
    : base
}

/** 多策略查找 pencil 可执行文件：环境变量 → 已知路径 → PATH 探测 */
async function resolvePencilBinary(): Promise<string | null> {
  // 1. 环境变量最优先（允许用户手动指定路径）
  const envBin = process.env["PENCIL_BIN"]
  if (envBin && await fileExists(envBin)) return envBin

  // 2. 各平台的已知安装路径
  for (const p of getKnownPaths()) {
    if (await fileExists(p)) return p
  }

  // 3. 通过 which/where 在 PATH 中查找
  return findOnPath()
}

function getKnownPaths(): string[] {
  if (process.platform === "darwin") {
    return [
      // "Install pencil command into PATH" 通常安装到此处
      "/usr/local/bin/pencil",
      path.join(os.homedir(), ".local", "bin", "pencil"),
      path.join(os.homedir(), "bin", "pencil"),
      "/opt/homebrew/bin/pencil",
      // 备用：直接调用 .app bundle 内部可执行文件
      "/Applications/Pencil.app/Contents/MacOS/Pencil",
      path.join(os.homedir(), "Applications", "Pencil.app", "Contents", "MacOS", "Pencil"),
    ]
  }
  if (process.platform === "win32") {
    const local = process.env["LOCALAPPDATA"] ?? ""
    return [
      path.join(local, "Programs", "Pencil", "pencil.exe"),
      path.join(local, "Programs", "pencil", "pencil.exe"),
    ]
  }
  // Linux
  return [
    "/usr/local/bin/pencil",
    "/usr/bin/pencil",
    path.join(os.homedir(), ".local", "bin", "pencil"),
  ]
}

async function findOnPath(): Promise<string | null> {
  const cmd = process.platform === "win32" ? "where" : "which"
  try {
    const { stdout } = await execFileAsync(cmd, ["pencil"], { timeout: 2_000 })
    const first = stdout.split(/\r?\n/).map(l => l.trim()).find(Boolean)
    return first ?? null
  } catch {
    return null
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    // 在 Linux/macOS 上额外验证可执行权限
    const { constants } = await import("node:fs")
    const mode = process.platform === "win32" ? constants.F_OK : constants.X_OK
    await fs.access(filePath, mode)
    return true
  } catch {
    return false
  }
}
