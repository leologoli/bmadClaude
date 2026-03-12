import { contextBridge, ipcRenderer } from "electron"
import {
  IPC,
  type BmadInstallRequest,
  type DepCheckResult,
  type PingRequest,
  type PtyKillRequest,
  type PtyResizeRequest,
  type PtySpawnRequest,
  type PtyWriteRequest,
  type WorkflowEventRequest,
  type WorkflowStartRequest,
  type WorkflowSnapshot,
  type PtyDataEvent,
  type PtyExitEvent,
  type FsEntry,
  type StorageProjectItem,
  type StorageUpsertProjectRequest,
} from "@bmad-claude/ipc-contracts"

// ============================================================
// 暴露给渲染进程的安全 API（通过 contextBridge）
// ============================================================

const api = {
  // 健康检查
  ping: (req: PingRequest) => ipcRenderer.invoke(IPC.PING, req),

  // 环境依赖检查
  deps: {
    check:         (): Promise<DepCheckResult>                   => ipcRenderer.invoke(IPC.DEP_CHECK),
    installClaude:    (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke(IPC.DEP_INSTALL_CLAUDE),
    installCodex:     (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke(IPC.DEP_INSTALL_CODEX),
    installGemini:    (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke(IPC.DEP_INSTALL_GEMINI),
    installAllInOne:  (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke(IPC.DEP_INSTALL_ALL_IN_ONE),
  },

  // 本地存储
  storage: {
    listProjects:  (): Promise<StorageProjectItem[]> => ipcRenderer.invoke(IPC.STORAGE_LIST_PROJECTS),
    deleteProject: (projectPath: string): Promise<void> => ipcRenderer.invoke(IPC.STORAGE_DELETE_PROJECT, projectPath),
    saveProject:   (req: StorageUpsertProjectRequest): Promise<void> => ipcRenderer.invoke(IPC.STORAGE_UPSERT_PROJECT, req),
  },

  // 原生对话框
  dialog: {
    openDir: (): Promise<string | null> => ipcRenderer.invoke(IPC.DIALOG_OPEN_DIR),
  },

  // 文件系统（懒加载目录内容）
  fs: {
    listDir: (dirPath: string): Promise<FsEntry[]> => ipcRenderer.invoke(IPC.FS_LIST_DIR, dirPath),
  },

  // BMAD-METHOD 安装器
  installer: {
    install:        (req: BmadInstallRequest) => ipcRenderer.invoke(IPC.BMAD_INSTALL, req),
    repairCommands: (req: BmadInstallRequest) => ipcRenderer.invoke(IPC.BMAD_REPAIR_COMMANDS, req),
  },

  // PTY 操作
  pty: {
    spawn:  (req: PtySpawnRequest)  => ipcRenderer.invoke(IPC.PTY_SPAWN, req),
    write:  (req: PtyWriteRequest)  => ipcRenderer.invoke(IPC.PTY_WRITE, req),
    resize: (req: PtyResizeRequest) => ipcRenderer.invoke(IPC.PTY_RESIZE, req),
    kill:   (req: PtyKillRequest)   => ipcRenderer.invoke(IPC.PTY_KILL, req),

    // 监听主进程推送的 PTY 输出数据
    onData: (fn: (event: PtyDataEvent) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, event: PtyDataEvent) => fn(event)
      ipcRenderer.on(IPC.PTY_DATA, handler)
      return () => ipcRenderer.off(IPC.PTY_DATA, handler)
    },

    // 监听 PTY 进程退出事件
    onExit: (fn: (event: PtyExitEvent) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, event: PtyExitEvent) => fn(event)
      ipcRenderer.on(IPC.PTY_EXIT, handler)
      return () => ipcRenderer.off(IPC.PTY_EXIT, handler)
    },
  },

  // BMAD 工作流操作
  workflow: {
    start:     (req: WorkflowStartRequest)  => ipcRenderer.invoke(IPC.WORKFLOW_START, req),
    sendEvent: (req: WorkflowEventRequest)  => ipcRenderer.invoke(IPC.WORKFLOW_EVENT, req),

    // 监听工作流状态快照更新
    onSnapshot: (fn: (snapshot: WorkflowSnapshot) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, snapshot: WorkflowSnapshot) => fn(snapshot)
      ipcRenderer.on(IPC.WORKFLOW_SNAPSHOT, handler)
      return () => ipcRenderer.off(IPC.WORKFLOW_SNAPSHOT, handler)
    },
  },
}

contextBridge.exposeInMainWorld("bmad", api)

export type BmadApi = typeof api
