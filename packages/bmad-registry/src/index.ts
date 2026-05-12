import fs from "node:fs/promises"
import https from "node:https"
import os from "node:os"
import path from "node:path"
import { load } from "js-yaml"
import type { BmadRole } from "@bmad-claude/ipc-contracts"

// ============================================================
// 常量
// ============================================================

const BMAD_REPO   = "bmad-code-org/BMAD-METHOD"
const BMAD_BRANCH = "main"
const CACHE_DIR   = path.join(os.homedir(), ".bmad-claude", "agents")

// ── Claude Code 命令描述表 ──
// 命令文件由本地模板生成（非直接下载），因为内容引用 {project-root}/_bmad/ 路径
interface ClaudeCommand {
  name:        string   // 最终文件名（不含 .md）
  description: string
  loadMd?:     string   // Pattern A：直接加载 .md 工作流文件
  yamlPath?:   string   // Pattern B：通过 workflow.xml 引擎执行 .yaml 配置
  inline?:     string   // Pattern C：内联指令，直接嵌入命令文件
}

const CLAUDE_COMMANDS: ClaudeCommand[] = [
  {
    name:        "bmad-help",
    description: "Get unstuck by showing what workflow steps come next or answering BMad Method questions.",
    loadMd:      "_bmad/core/tasks/help.md",
  },
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
    name:        "bmad-generate-wireframe",
    description: "Generate text-based wireframe based on UX requirements discussed in the conversation. Use when user says 'generate wireframe' or 'create wireframe'.",
    inline:
      `根据本次对话中讨论的 UX 需求和设计决策，生成详细的文本线框图。\n` +
      `\n` +
      `要求：\n` +
      `- 使用 Unicode 框线字符（┌─┐│└┘├┤┬┴┼）构建结构\n` +
      `- 清晰标注所有 UI 组件\n` +
      `- 包含：导航栏、主内容区、关键控件、交互元素\n` +
      `- 为重要交互添加简短注释\n` +
      `- 只输出线框图本体，不附加额外解释`,
  },
  {
    name:        "bmad-save-wireframe",
    description: "Save the text-based wireframe from this conversation to planning-artifacts/wireframe.md. Use when user says 'save wireframe' or 'save the wireframe'.",
    inline:
      `从本次对话中提取最新的文本线框图，以 Markdown 格式保存到 {project-root}/_bmad-output/planning-artifacts/wireframe.md。\n` +
      `\n` +
      `步骤：\n` +
      `1. 若 {project-root}/_bmad-output/planning-artifacts/ 目录不存在则创建\n` +
      `2. 将线框图内容写入 {project-root}/_bmad-output/planning-artifacts/wireframe.md，格式如下：\n` +
      `   - 文件顶部写标题 "# 页面线框图"\n` +
      `   - 每个页面/屏幕用 "## 页面名称" 作为二级标题\n` +
      `   - 线框图内容包裹在 \`\`\`text 代码块中\n` +
      `3. 完成后告知用户文件已保存及其完整路径\n` +
      `4. 若对话中尚未生成线框图，告知用户先执行 /bmad-generate-wireframe`,
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

  if (cmd.inline) {
    // Pattern C：内联指令，直接嵌入命令文件（无需外部 workflow 文件）
    return header + cmd.inline + "\n\n$ARGUMENTS\n"
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
// BmadInstaller：写入 bmad-claude 的本地配置与修复命令
// （_bmad/ 文件和 .claude/commands/ 由上层 npx bmad-method install 负责）
// ============================================================

export class BmadInstaller {
  /**
   * npx bmad-method install 完成后调用，写入 bmad-claude 专属配置：
   * 中文语言设置、输出路径、manifest 等。
   */
  async install(
    projectPath: string,
    projectName: string,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      await fs.mkdir(projectPath, { recursive: true })
      await this.writeConfigs(projectPath, projectName)
      console.log("[BMAD-INSTALL] Configs written")
      return { ok: true }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: msg }
    }
  }

  // ── 写入全部 BMAD 配置文件 ──
  private async writeConfigs(
    projectPath: string,
    projectName: string,
  ): Promise<void> {
    const docsPath = "_bmad-output"
    const now = new Date().toISOString()

    // 以下三个配置由 bmad-claude 强制覆写，确保中文语言设置和输出路径生效
    // （npx bmad-method install 可能生成英文默认值，此处覆盖）

    // _bmad/bmm/config.yaml
    await this.writeForce(
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
    await this.writeForce(
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
    await this.writeForce(
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

  // ── 强制写入，覆盖已有文件（用于 bmad-claude 专属配置覆盖 npx 默认值）──
  private async writeForce(filePath: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, content, "utf-8")
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
