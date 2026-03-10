import os from "node:os"
import * as pty from "node-pty"

// ============================================================
// PTY 会话配置
// ============================================================

export interface SessionOptions {
  cwd: string
  cols?: number
  rows?: number
  env?: NodeJS.ProcessEnv
}

// ============================================================
// 单个 PTY 会话封装
// ============================================================

export class PtySession {
  private readonly proc: pty.IPty
  private readonly listeners = new Set<(data: string) => void>()
  private readonly exitListeners = new Set<(code: number, signal?: number) => void>()
  private killed = false  // 防止 exit 回调触发后再次 kill

  constructor(opts: SessionOptions) {
    const shell = getDefaultShell()
    this.proc = pty.spawn(shell, [], {
      name: "xterm-color",
      cwd: opts.cwd,
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 30,
      env: opts.env ?? process.env,
    })

    // 将输出广播给所有监听器
    this.proc.onData((data) => {
      for (const fn of this.listeners) fn(data)
    })

    this.proc.onExit(({ exitCode, signal }) => {
      for (const fn of this.exitListeners) fn(exitCode, signal)
    })
  }

  write(data: string): void {
    this.proc.write(data)
  }

  resize(cols: number, rows: number): void {
    this.proc.resize(cols, rows)
  }

  kill(signal = 15): void {
    if (this.killed) return
    this.killed = true
    this.proc.kill(signal)
  }

  /** 注册数据监听器，返回取消订阅函数 */
  onData(fn: (data: string) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  onExit(fn: (exitCode: number, signal?: number) => void): () => void {
    this.exitListeners.add(fn)
    return () => this.exitListeners.delete(fn)
  }
}

// ============================================================
// 会话管理器：维护 sessionId → PtySession 的映射
// ============================================================

export class PtySessionManager {
  private readonly sessions = new Map<string, PtySession>()

  spawn(sessionId: string, opts: SessionOptions): PtySession {
    // 若已存在同 ID 会话，先清理
    this.kill(sessionId)
    const session = new PtySession(opts)
    this.sessions.set(sessionId, session)
    return session
  }

  get(sessionId: string): PtySession | undefined {
    return this.sessions.get(sessionId)
  }

  write(sessionId: string, data: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.write(data)
    return true
  }

  resize(sessionId: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.resize(cols, rows)
    return true
  }

  kill(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.kill()
      this.sessions.delete(sessionId)
    }
  }

  killAll(): void {
    for (const [id] of this.sessions) this.kill(id)
  }
}

// ============================================================
// 工具函数
// ============================================================

function getDefaultShell(): string {
  if (process.platform === "win32") return "powershell.exe"
  return process.env.SHELL ?? (os.platform() === "darwin" ? "/bin/zsh" : "/bin/bash")
}
