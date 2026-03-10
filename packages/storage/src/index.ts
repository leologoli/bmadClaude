import fs from "node:fs"
import path from "node:path"
import os from "node:os"

// ============================================================
// 基于 JSON 文件的本地存储（零原生依赖，MVP 阶段足够）
// ============================================================

const DEFAULT_DATA_DIR = path.join(os.homedir(), ".bmad-claude", "data")

export interface ProjectRecord {
  id:        string
  name:      string
  path:      string
  createdAt: number
  updatedAt: number
}

interface WorkflowRunRecord {
  id:        string
  projectId: string
  snapshot:  unknown
  createdAt: number
  updatedAt: number
}

interface StoreData {
  projects:     ProjectRecord[]
  workflowRuns: WorkflowRunRecord[]
}

// ============================================================
// ProjectStorage：读写 JSON 文件
// ============================================================

export class ProjectStorage {
  private readonly filePath: string
  private data: StoreData

  constructor(dataDir = DEFAULT_DATA_DIR) {
    fs.mkdirSync(dataDir, { recursive: true })
    this.filePath = path.join(dataDir, "store.json")
    this.data = this.load()
  }

  createProject(record: ProjectRecord): void {
    // 去重：同 ID 则覆盖
    this.data.projects = this.data.projects.filter(p => p.id !== record.id)
    this.data.projects.push(record)
    this.save()
  }

  // 删除某路径的全部历史记录（包括关联的 workflowRuns）
  deleteProject(projectPath: string): void {
    const ids = this.data.projects.filter(p => p.path === projectPath).map(p => p.id)
    this.data.projects     = this.data.projects.filter(p => p.path !== projectPath)
    this.data.workflowRuns = this.data.workflowRuns.filter(r => !ids.includes(r.projectId))
    this.save()
  }

  listProjects(): ProjectRecord[] {
    // 按路径去重，每个路径只保留最近一条记录
    const byPath = new Map<string, ProjectRecord>()
    for (const p of this.data.projects) {
      const cur = byPath.get(p.path)
      if (!cur || p.updatedAt > cur.updatedAt) byPath.set(p.path, p)
    }
    return [...byPath.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  upsertWorkflowSnapshot(runId: string, projectId: string, snapshot: unknown): void {
    const now = Date.now()
    const existing = this.data.workflowRuns.findIndex(r => r.id === runId)
    if (existing >= 0) {
      this.data.workflowRuns[existing] = { id: runId, projectId, snapshot, createdAt: this.data.workflowRuns[existing].createdAt, updatedAt: now }
    } else {
      this.data.workflowRuns.push({ id: runId, projectId, snapshot, createdAt: now, updatedAt: now })
    }
    this.save()
  }

  // 获取某项目最近一次工作流的当前角色（用于恢复会话时显示上次进度）
  getLatestRoleForProject(projectId: string): string | null {
    const run = this.data.workflowRuns
      .filter(r => r.projectId === projectId)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (!run) return null
    const snap = run.snapshot as { currentRole?: string }
    return snap?.currentRole ?? null
  }

  // storage 不需要显式关闭，但保留接口一致性
  close(): void {}

  // ──── 私有方法 ────

  private load(): StoreData {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8")
      return JSON.parse(raw) as StoreData
    } catch {
      return { projects: [], workflowRuns: [] }
    }
  }

  private save(): void {
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf-8")
  }
}
