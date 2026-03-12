// ============================================================
// IPC 通道名称常量：主进程与渲染进程之间的通信协议
// ============================================================

export const IPC = {
  // 健康检查
  PING: "core:ping",

  // PTY 会话管理（invoke = 请求-响应）
  PTY_SPAWN: "pty:spawn",
  PTY_WRITE: "pty:write",
  PTY_RESIZE: "pty:resize",
  PTY_KILL: "pty:kill",

  // PTY 数据推送（on/send = 事件流）
  PTY_DATA: "pty:data",
  PTY_EXIT: "pty:exit",

  // BMAD 工作流
  WORKFLOW_START: "workflow:start",
  WORKFLOW_EVENT: "workflow:event",
  WORKFLOW_SNAPSHOT: "workflow:snapshot",

  // BMAD-METHOD 安装器
  BMAD_INSTALL: "bmad:install",
  // 仅重新生成命令文件（修复）
  BMAD_REPAIR_COMMANDS: "bmad:repair-commands",

  // 环境依赖检查与安装
  DEP_CHECK:           "dep:check",
  DEP_INSTALL_CLAUDE:      "dep:install-claude",
  DEP_INSTALL_CODEX:       "dep:install-codex",
  DEP_INSTALL_GEMINI:      "dep:install-gemini",
  DEP_INSTALL_ALL_IN_ONE:  "dep:install-all-in-one",

  // 本地存储
  STORAGE_LIST_PROJECTS:   "storage:list-projects",
  STORAGE_DELETE_PROJECT:  "storage:delete-project",
  STORAGE_UPSERT_PROJECT:  "storage:upsert-project",

  // 原生对话框
  DIALOG_OPEN_DIR: "dialog:open-dir",

  // 文件系统
  FS_LIST_DIR: "fs:list-dir",
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

// ============================================================
// PTY 相关类型
// ============================================================

export interface PtySpawnRequest {
  sessionId: string  // 由渲染进程生成的唯一 ID（UUID）
  cwd: string        // 项目工作目录
  cols?: number
  rows?: number
  env?: Record<string, string>
}

export interface PtyWriteRequest {
  sessionId: string
  data: string
}

export interface PtyResizeRequest {
  sessionId: string
  cols: number
  rows: number
}

export interface PtyKillRequest {
  sessionId: string
}

// 主进程推送给渲染进程的 PTY 输出事件
export interface PtyDataEvent {
  sessionId: string
  data: string
}

export interface PtyExitEvent {
  sessionId: string
  exitCode: number
  signal?: number
}

// ============================================================
// BMAD 工作流相关类型
// ============================================================

/** BMAD 角色阶段，按照标准流程排列 */
export type BmadRole =
  | "intake"       // 项目信息收集
  | "brainstorm"   // 头脑风暴与方向探索
  | "analyst"      // BA：需求分析与澄清
  | "pm"           // PM：撰写 PRD
  | "ux-designer"  // UX/UI 设计：交互与视觉规范
  | "architect"    // 架构师：技术方案设计
  | "epic-planner" // 史诗规划：分解故事并验证准备度
  | "developer"    // 开发者：编码实现
  | "qa"           // QA：质量审查
  | "done"         // 已完成
  | "failed"       // 异常中断

/** 工作流事件类型 */
export type WorkflowEventType =
  | { type: "NEXT" }                           // 推进到下一阶段
  | { type: "FAIL"; reason: string }           // 标记失败
  | { type: "RETRY" }                          // 从失败中恢复
  | { type: "SWITCH_ROLE"; target: BmadRole; initialMessage?: string }  // 手动切换角色
  | { type: "APPROVE" }                        // 人工审批通过
  | { type: "AUTO_ADVANCE"; target: BmadRole; confidence: number } // 自动推进

export interface WorkflowStartRequest {
  workflowId: string
  projectName: string
  projectPath: string
  initialRole?: BmadRole
}

export interface WorkflowEventRequest {
  workflowId: string
  event: WorkflowEventType
}

/** 工作流快照：渲染进程用于更新 UI */
export interface WorkflowSnapshot {
  workflowId: string
  currentRole: BmadRole
  previousRole?: BmadRole
  isManualLock: boolean    // true 时禁止自动切换
  failureReason?: string
  artifacts: ArtifactRef[]
  transitionLog: TransitionLogEntry[]
}

export interface ArtifactRef {
  role: BmadRole
  name: string             // 如 "PRD.md"、"architecture.md"
  path: string             // 本地文件路径
  createdAt: number
}

export interface TransitionLogEntry {
  from: BmadRole
  to: BmadRole
  reason: string
  timestamp: number
  automatic: boolean
}

// ============================================================
// BMAD-METHOD 安装器
// ============================================================

export interface BmadInstallRequest {
  projectPath:  string
  projectName?: string   // 用于生成 _bmad/bmm/config.yaml
}

export interface BmadInstallResponse {
  ok: boolean
  error?: string         // 失败时的错误信息
  stdout: string
  stderr: string
}

// ============================================================
// 本地存储
// ============================================================

/** 历史项目列表条目（含上次进度） */
export interface StorageProjectItem {
  id:        string
  name:      string
  path:      string
  updatedAt: number
  lastRole?: string   // 上次会话的当前角色（如 "pm"、"architect"）
  isPlain?:  boolean  // true 表示普通任务（无 BMAD 工作流）
}

/** 保存/更新项目记录的请求 */
export interface StorageUpsertProjectRequest {
  id:       string
  name:     string
  path:     string
  isPlain?: boolean
}

// ============================================================
// 环境依赖检查
// ============================================================

export interface DepStatus {
  installed: boolean
  version?:  string
}

export interface DepCheckResult {
  node:     DepStatus
  npm:      DepStatus
  claude:   DepStatus
  codex:    DepStatus
  gemini:   DepStatus
  uvx:      DepStatus  // uv/uvx（All-in-One MCP server 运行依赖）
  allInOne: DepStatus  // HelpAI All-in-One 多模型环境（Codex+Gemini MCP + CLAUDE.md）
}

// ============================================================
// 文件系统
// ============================================================

export interface FsEntry {
  name:  string
  path:  string          // 绝对路径
  isDir: boolean
}

// ============================================================
// 健康检查
// ============================================================

export interface PingRequest { message: string }
export interface PingResponse { message: string; timestamp: number }
