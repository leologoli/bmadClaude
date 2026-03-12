import fs from "node:fs/promises"
import https from "node:https"
import os from "node:os"
import path from "node:path"
import { load } from "js-yaml"
import type { BmadRole } from "@bmad-claude/ipc-contracts"

// ============================================================
// 常量
// ============================================================

const BMAD_REPO       = "bmad-code-org/BMAD-METHOD"
const BMAD_BRANCH     = "main"
const CACHE_DIR       = path.join(os.homedir(), ".bmad-claude", "agents")
const BMAD_CACHE_ROOT = path.join(os.homedir(), ".bmad-claude", "bmad-cache")

// ── 需要从 GitHub 下载并安装到 _bmad/ 的目录前缀 ──
// src/core/ 包含：agents、tasks（含 workflow.xml）、workflows
// src/bmm/  包含：agents、workflows（含所有阶段工作流）
const INSTALL_PREFIXES = [
  "src/bmm/",
  "src/core/",
]

// ── Claude Code 命令描述表 ──
// 命令文件由本地模板生成（非直接下载），因为内容引用 {project-root}/_bmad/ 路径
interface ClaudeCommand {
  name:        string   // 最终文件名（不含 .md）
  description: string
  loadMd?:     string   // Pattern A：直接加载 .md 工作流文件
  yamlPath?:   string   // Pattern B：通过 workflow.xml 引擎执行 .yaml 配置
}

const CLAUDE_COMMANDS: ClaudeCommand[] = [
  {
    name:        "bmad-brainstorming",
    description: "Facilitate interactive brainstorming sessions. Use when user says 'help me brainstorm' or 'help me ideate'.",
    loadMd:      "_bmad/core/workflows/brainstorming/workflow.md",
  },
  {
    name:        "bmad-bmm-create-product-brief",
    description: "Create product brief through collaborative discovery. Use when user says 'lets create a product brief' or 'help me create a project brief'.",
    loadMd:      "_bmad/bmm/workflows/1-analysis/create-product-brief/workflow.md",
  },
  {
    name:        "bmad-bmm-create-prd",
    description: "Create a PRD from scratch. Use when user says 'lets create a product requirements document' or 'I want to create a new PRD'.",
    loadMd:      "_bmad/bmm/workflows/2-plan-workflows/create-prd/workflow-create-prd.md",
  },
  {
    name:        "bmad-bmm-create-ux-design",
    description: "Plan UX patterns and design specifications. Use when user says 'lets create UX design' or 'create UX specifications'.",
    loadMd:      "_bmad/bmm/workflows/2-plan-workflows/create-ux-design/workflow.md",
  },
  {
    name:        "bmad-bmm-create-architecture",
    description: "Create architecture solution design. Use when user says 'lets create architecture' or 'create technical architecture'.",
    loadMd:      "_bmad/bmm/workflows/3-solutioning/create-architecture/workflow.md",
  },
  {
    name:        "bmad-create-epics-and-stories",
    description: "Break requirements into epics and user stories. Use when user says 'create the epics and stories list'.",
    loadMd:      "_bmad/bmm/workflows/3-solutioning/create-epics-and-stories/workflow.md",
  },
  {
    name:        "bmad-check-implementation-readiness",
    description: "Validate PRD, UX, Architecture and Epics specs are complete. Use when user says 'check implementation readiness'.",
    loadMd:      "_bmad/bmm/workflows/3-solutioning/check-implementation-readiness/workflow.md",
  },
  {
    name:        "bmad-sprint-planning",
    description: "Generate sprint status tracking from epics. Use when user says 'run sprint planning' or 'generate sprint plan'.",
    loadMd:      "_bmad/bmm/workflows/4-implementation/sprint-planning/workflow.md",
  },
  {
    name:        "bmad-create-story",
    description: "Creates a dedicated story file with all the context the agent will need to implement it later. Use when user says 'create the next story' or 'create story [story identifier]'.",
    loadMd:      "_bmad/bmm/workflows/4-implementation/create-story/workflow.md",
  },
  {
    name:        "bmad-bmm-dev-story",
    description: "Execute story implementation following a context filled story spec file. Use when user says 'dev this story [story file]' or 'implement the next story'.",
    yamlPath:    "_bmad/bmm/workflows/4-implementation/dev-story/workflow.yaml",
  },
  {
    name:        "bmad-code-review",
    description: "Perform adversarial code review finding specific issues. Use when user says 'run code review' or 'review this code'.",
    loadMd:      "_bmad/bmm/workflows/4-implementation/code-review/workflow.md",
  },
  {
    name:        "bmad-retrospective",
    description: "Post-epic review to extract lessons and assess success. Use when user says 'run a retrospective' or 'lets retro the epic [epic]'.",
    loadMd:      "_bmad/bmm/workflows/4-implementation/retrospective/workflow.md",
  },
  {
    name:        "bmad-correct-course",
    description: "Manage significant changes during sprint execution. Use when user says 'correct course' or 'propose sprint change'.",
    loadMd:      "_bmad/bmm/workflows/4-implementation/correct-course/workflow.md",
  },
  {
    name:        "bmad-bmm-qa-generate-e2e-tests",
    description: "Generate end to end automated tests for existing features. Use when user says 'create qa automated tests for [feature]'.",
    yamlPath:    "_bmad/bmm/workflows/qa-generate-e2e-tests/workflow.yaml",
  },
]

// ============================================================
// HTTP 工具
// ============================================================

function httpsGet(url: string, headers?: Record<string, string>): Promise<string | null> {
  return new Promise((resolve) => {
    https.get(url, { headers: { "User-Agent": "bmad-claude/1.0", ...headers } }, (res) => {
      if (res.statusCode !== 200) { resolve(null); return }
      const chunks: Buffer[] = []
      res.on("data", (c: Buffer) => chunks.push(c))
      res.on("end",  ()          => resolve(Buffer.concat(chunks).toString("utf-8")))
      res.on("error",()          => resolve(null))
    }).on("error", () => resolve(null))
  })
}

// ============================================================
// 生成 Claude Code 命令文件内容
// ============================================================

function buildCommandContent(cmd: ClaudeCommand): string {
  // YAML frontmatter（Claude Code 用于描述命令）
  const shortName = cmd.name.replace(/^bmad-bmm-|^bmad-/, "")
  const header = `---\nname: '${shortName}'\ndescription: '${cmd.description}'\n---\n\n`

  if (cmd.loadMd) {
    // Pattern A：直接加载 workflow.md
    return (
      header +
      `IT IS CRITICAL THAT YOU FOLLOW THIS COMMAND: LOAD the FULL {project-root}/${cmd.loadMd},` +
      ` READ its entire contents and follow its directions exactly!\n` +
      `\n$ARGUMENTS\n`
    )
  }

  if (cmd.yamlPath) {
    // Pattern B：通过 workflow.xml CORE OS 执行 yaml 配置
    return (
      header +
      `IT IS CRITICAL THAT YOU FOLLOW THESE STEPS - while staying in character as the current agent persona you may have loaded:\n\n` +
      `<steps CRITICAL="TRUE">\n` +
      `1. Always LOAD the FULL {project-root}/_bmad/core/tasks/workflow.xml\n` +
      `2. READ its entire contents - this is the CORE OS for EXECUTING the specific workflow-config {project-root}/${cmd.yamlPath}\n` +
      `3. Pass the yaml path {project-root}/${cmd.yamlPath} as 'workflow-config' parameter to the workflow.xml instructions\n` +
      `4. Follow workflow.xml instructions EXACTLY as written to process and follow the specific workflow config and its instructions\n` +
      `5. Save outputs after EACH section when generating any documents from templates\n` +
      `</steps>\n` +
      `\n$ARGUMENTS\n`
    )
  }

  return header
}

// ============================================================
// BmadInstaller：从 GitHub 复制文件到项目，无需 npx
// ============================================================

interface GithubFile { path: string; type: string }
interface GithubTree { sha: string; tree: GithubFile[] }

export class BmadInstaller {
  /**
   * 将 BMAD-METHOD 工作流文件安装到目标项目：
   * 1. 获取 GitHub 文件树（1 次 API 请求）
   * 2. 并行下载 src/core/ + src/bmm/（每批 20 个并发）
   * 3. 写入 _bmad/ 目录（路径映射：src/core → _bmad/core，src/bmm → _bmad/bmm）
   * 4. 生成 .claude/commands/bmad-*.md 命令文件（本地模板生成）
   * 5. 生成配置文件（_bmad/bmm/config.yaml、_bmad/core/config.yaml 等）
   */
  async install(
    projectPath: string,
    projectName: string,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      await fs.mkdir(projectPath, { recursive: true })

      // ── 1. 获取完整文件树（单次 API 调用）──
      const treeData = await this.fetchTree()
      if (!treeData) return { ok: false, error: "无法连接 GitHub，请检查网络" }
      const { sha, tree } = treeData

      // ── 2. 筛选需要安装的文件 ──
      const toInstall = tree
        .filter(f => f.type === "blob" && INSTALL_PREFIXES.some(p => f.path.startsWith(p)))
        .map(f => ({
          src:  f.path,
          rel:  f.path.slice("src/".length),                              // 缓存内相对路径
          dest: path.join(projectPath, "_bmad", f.path.slice("src/".length)),
        }))

      // ── 3. 命中缓存则直接复制；未命中则下载并同步回填缓存 ──
      const cacheDir = path.join(BMAD_CACHE_ROOT, sha)
      if (await this.hasCompleteCache(cacheDir)) {
        console.log(`[BMAD-INSTALL] Cache hit: ${sha}`)
        await this.copyFromCache(cacheDir, toInstall)
      } else {
        console.log(`[BMAD-INSTALL] Downloading ${toInstall.length} files (sha: ${sha})`)
        // 清除残缺的旧缓存，确保本次写入干净
        await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => {})
        await fs.mkdir(cacheDir, { recursive: true })
        await this.downloadBatch(toInstall, cacheDir)
        // 所有文件写完后打哨兵，标记缓存完整
        await fs.writeFile(path.join(cacheDir, ".complete"), sha, "utf-8")
          .catch(e => console.warn("[BMAD-INSTALL] Cache sentinel write failed:", e))
      }

      // ── 4. 生成 .claude/commands/ 命令文件（本地模板，无需网络）──
      const commandsDir = path.join(projectPath, ".claude", "commands")
      await fs.mkdir(commandsDir, { recursive: true })

      await Promise.all(CLAUDE_COMMANDS.map(async (cmd) => {
        const content = buildCommandContent(cmd)
        await fs.writeFile(path.join(commandsDir, `${cmd.name}.md`), content, "utf-8")
        console.log(`[BMAD-INSTALL] Command: ${cmd.name}`)
      }))

      // ── 5. 生成配置文件 ──
      await this.writeConfigs(projectPath, projectName)

      console.log("[BMAD-INSTALL] Done")
      return { ok: true }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: msg }
    }
  }

  // ── 获取仓库文件树（单次 API 请求）──
  private async fetchTree(): Promise<GithubTree | null> {
    const url = `https://api.github.com/repos/${BMAD_REPO}/git/trees/${BMAD_BRANCH}?recursive=1`
    const raw  = await httpsGet(url)
    if (!raw) return null
    try {
      const data = JSON.parse(raw) as { sha?: string; tree?: GithubFile[] }
      if (typeof data.sha !== "string" || !Array.isArray(data.tree)) return null
      return { sha: data.sha, tree: data.tree }
    } catch { return null }
  }

  // ── 批量并发下载；同步写入 cacheDir（传 null 则不缓存）──
  private async downloadBatch(
    files: Array<{ src: string; rel: string; dest: string }>,
    cacheDir: string | null = null,
    concurrency = 20,
  ): Promise<void> {
    for (let i = 0; i < files.length; i += concurrency) {
      const batch = files.slice(i, i + concurrency)
      await Promise.all(batch.map(async ({ src, rel, dest }) => {
        const url     = `https://raw.githubusercontent.com/${BMAD_REPO}/${BMAD_BRANCH}/${src}`
        const content = await httpsGet(url)
        if (content !== null) {
          await fs.mkdir(path.dirname(dest), { recursive: true })
          await fs.writeFile(dest, content, "utf-8")
          // 下载成功时同步写入缓存（与 dest 同内容，避免回拷遗漏失败文件）
          if (cacheDir) {
            const cacheDest = path.join(cacheDir, rel)
            await fs.mkdir(path.dirname(cacheDest), { recursive: true })
            await fs.writeFile(cacheDest, content, "utf-8")
          }
        }
      }))
    }
  }

  // ── 缓存完整性检查（以 .complete 哨兵文件为准）──
  private async hasCompleteCache(cacheDir: string): Promise<boolean> {
    try { await fs.access(path.join(cacheDir, ".complete")); return true }
    catch { return false }
  }

  // ── 从缓存复制到项目目录 ──
  private async copyFromCache(
    cacheDir: string,
    files: Array<{ rel: string; dest: string }>,
    concurrency = 20,
  ): Promise<void> {
    for (let i = 0; i < files.length; i += concurrency) {
      const batch = files.slice(i, i + concurrency)
      await Promise.all(batch.map(async ({ rel, dest }) => {
        const src = path.join(cacheDir, rel)
        await fs.mkdir(path.dirname(dest), { recursive: true })
        await fs.copyFile(src, dest)
      }))
    }
  }

  // ── 写入全部 BMAD 配置文件 ──
  private async writeConfigs(
    projectPath: string,
    projectName: string,
  ): Promise<void> {
    const docsPath = "_bmad-output"
    const now = new Date().toISOString()

    // _bmad/bmm/config.yaml
    await this.writeOnce(
      path.join(projectPath, "_bmad", "bmm", "config.yaml"),
      [
        `# BMM Module Configuration`,
        `# Generated by bmad-claude installer`,
        ``,
        `project_name: "${projectName}"`,
        `user_skill_level: intermediate`,
        `planning_artifacts: "{project-root}/_bmad-output/planning-artifacts"`,
        `implementation_artifacts: "{project-root}/_bmad-output/implementation-artifacts"`,
        `project_knowledge: "{project-root}/${docsPath}"`,
        ``,
        `# Core Configuration Values`,
        `communication_language: chinese`,
        `document_output_language: chinese`,
        `output_folder: "{project-root}/_bmad-output"`,
      ].join("\n") + "\n",
    )

    // _bmad/core/config.yaml
    await this.writeOnce(
      path.join(projectPath, "_bmad", "core", "config.yaml"),
      [
        `# CORE Module Configuration`,
        `# Generated by bmad-claude installer`,
        ``,
        `communication_language: chinese`,
        `document_output_language: chinese`,
        `output_folder: "{project-root}/_bmad-output"`,
      ].join("\n") + "\n",
    )

    // _bmad/_memory/config.yaml
    await this.writeOnce(
      path.join(projectPath, "_bmad", "_memory", "config.yaml"),
      [
        `# _MEMORY Module Configuration`,
        `# Generated by bmad-claude installer`,
        ``,
        `communication_language: chinese`,
        `document_output_language: chinese`,
        `output_folder: "{project-root}/_bmad-output"`,
      ].join("\n") + "\n",
    )

    // _bmad/_config/manifest.yaml
    await this.writeOnce(
      path.join(projectPath, "_bmad", "_config", "manifest.yaml"),
      [
        `installation:`,
        `  version: 6.0.4`,
        `  installDate: ${now}`,
        `  lastUpdated: ${now}`,
        `modules:`,
        `  - name: core`,
        `    version: 6.0.4`,
        `    installDate: ${now}`,
        `    lastUpdated: ${now}`,
        `    source: built-in`,
        `    npmPackage: null`,
        `    repoUrl: null`,
        `  - name: bmm`,
        `    version: 6.0.4`,
        `    installDate: ${now}`,
        `    lastUpdated: ${now}`,
        `    source: built-in`,
        `    npmPackage: null`,
        `    repoUrl: null`,
        `ides:`,
        `  - claude-code`,
      ].join("\n") + "\n",
    )

    // _bmad/_config/ides/claude-code.yaml
    await this.writeOnce(
      path.join(projectPath, "_bmad", "_config", "ides", "claude-code.yaml"),
      [
        `ide: claude-code`,
        `configured_date: ${now}`,
        `last_updated: ${now}`,
        `configuration:`,
        `  _noConfigNeeded: true`,
      ].join("\n") + "\n",
    )
  }

  /**
   * 仅重新生成 .claude/commands/bmad-*.md 命令文件（无需网络，不覆盖 _bmad/ 核心文件）
   * 用于修复因版本更新导致命令文件缺失的情况
   */
  async repairCommands(projectPath: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const commandsDir = path.join(projectPath, ".claude", "commands")
      await fs.mkdir(commandsDir, { recursive: true })
      await Promise.all(CLAUDE_COMMANDS.map(async (cmd) => {
        const content = buildCommandContent(cmd)
        await fs.writeFile(path.join(commandsDir, `${cmd.name}.md`), content, "utf-8")
        console.log(`[BMAD-REPAIR] Command: ${cmd.name}`)
      }))
      return { ok: true }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: msg }
    }
  }

  // ── 若文件已存在则不覆盖 ──
  private async writeOnce(filePath: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    try {
      await fs.access(filePath)
      // 已存在，跳过
    } catch {
      await fs.writeFile(filePath, content, "utf-8")
    }
  }
}

// ============================================================
// BmadRegistry：缓存并解析 agent YAML（供未来扩展使用）
// ============================================================

const ROLE_FILE: Partial<Record<BmadRole, string>> = {
  analyst:   "analyst.agent.yaml",
  pm:        "pm.agent.yaml",
  architect: "architect.agent.yaml",
  developer: "dev.agent.yaml",
  qa:        "qa.agent.yaml",
}

export interface AgentProfile {
  name:       string
  title:      string
  role:       string
  identity:   string
  style:      string
  principles: string[]
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type YamlDoc = Record<string, any>

export function parseAgentYaml(yaml: string): AgentProfile | null {
  let doc: unknown
  try { doc = load(yaml) } catch { return null }

  const root    = doc as YamlDoc
  const meta    = root?.agent?.metadata  as YamlDoc | undefined
  const persona = root?.agent?.persona   as YamlDoc | undefined
  if (!meta && !persona) return null

  const name  = String(meta?.name  ?? "BMAD Agent")
  const title = String(meta?.title ?? name)
  const role  = String(persona?.role ?? title)
  const identity = String(persona?.identity ?? "")
  const style = String(persona?.communication_style ?? "清晰、直接、逻辑严谨")
  const principles = String(persona?.principles ?? "")
    .split("\n")
    .map((l: string) => l.replace(/^[-*•]\s*/, "").trim())
    .filter((l: string) => l.length > 0)

  return { name, title, role, identity, style, principles }
}

export class BmadRegistry {
  private readonly cacheDir: string

  constructor(cacheDir = CACHE_DIR) {
    this.cacheDir = cacheDir
  }

  async init(): Promise<void> {
    await fs.mkdir(this.cacheDir, { recursive: true })
  }

  async syncAll(): Promise<{ synced: BmadRole[]; failed: BmadRole[] }> {
    await this.init()
    const synced: BmadRole[] = []
    const failed: BmadRole[] = []

    for (const [role, filename] of Object.entries(ROLE_FILE) as [BmadRole, string][]) {
      const url = `https://raw.githubusercontent.com/${BMAD_REPO}/${BMAD_BRANCH}/src/bmm/agents/${filename}`
      const content = await httpsGet(url)
      if (content) {
        await fs.writeFile(path.join(this.cacheDir, filename), content, "utf-8")
        synced.push(role)
      } else {
        failed.push(role)
      }
    }
    return { synced, failed }
  }
}
