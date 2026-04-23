import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import type { BmadRole, DepCheckResult, WorkflowSnapshot, StorageProjectItem } from "@bmad-claude/ipc-contracts"

// ============================================================
// BMAD 角色配置
// ============================================================

interface RoleConfig {
  label: string
  description: string
  emoji: string
}

const ROLE_CONFIGS: Record<BmadRole, RoleConfig> = {
  intake:       { label: "项目导入",   description: "填写项目基本信息",         emoji: "📋" },
  brainstorm:   { label: "头脑风暴",   description: "探索创意与方向",           emoji: "💡" },
  analyst:      { label: "需求分析",   description: "BA 澄清与分析需求",        emoji: "🔍" },
  pm:           { label: "产品规划",   description: "PM 撰写 PRD 文档",         emoji: "📝" },
  "ux-designer":{ label: "UX/UI 设计", description: "交互设计与视觉规范",     emoji: "🎨" },
  architect:    { label: "架构设计",   description: "架构师制定技术方案",       emoji: "🏗️" },
  "epic-planner":{ label: "史诗规划",  description: "分解故事并验证准备度",     emoji: "📚" },
  developer:    { label: "编码实现",   description: "开发者实现功能代码",       emoji: "💻" },
  qa:           { label: "质量审查",   description: "QA 验收与测试",            emoji: "✅" },
  done:         { label: "已完成",     description: "项目交付完成",             emoji: "🎉" },
  failed:       { label: "中断",       description: "工作流异常中断",           emoji: "❌" },
}

const ROLE_SEQUENCE: BmadRole[] = [
  "intake", "brainstorm", "analyst", "pm", "ux-designer", "architect", "epic-planner", "developer", "qa", "done",
]

// Catppuccin Mocha 主题
const MOCHA_THEME = {
  background:   "#1e1e2e",
  foreground:   "#cdd6f4",
  cursor:       "#f5e0dc",
  cursorAccent: "#1e1e2e",
  selectionBackground: "#585b7060",
  black:        "#45475a",
  red:          "#f38ba8",
  green:        "#a6e3a1",
  yellow:       "#f9e2af",
  blue:         "#89b4fa",
  magenta:      "#cba6f7",
  cyan:         "#89dceb",
  white:        "#bac2de",
  brightBlack:  "#585b70",
  brightRed:    "#f38ba8",
  brightGreen:  "#a6e3a1",
  brightYellow: "#f9e2af",
  brightBlue:   "#89b4fa",
  brightMagenta:"#cba6f7",
  brightCyan:   "#89dceb",
  brightWhite:  "#a6adc8",
}

// ============================================================
// App
// ============================================================

type PtyStatus    = "disconnected" | "connected" | "exited"
type InstallPhase = "idle" | "checking-deps" | "installing-claude" | "installing-optional" | "installing-all-in-one" | "installing" | "done" | "error"
// 应用页面状态：项目列表 → 新建表单 / 直接进入
type AppScreen    = "picker" | "intake" | "plain" | "session"

export default function App() {
  const [screen, setScreen]             = useState<AppScreen>("picker")
  const [projects, setProjects]         = useState<StorageProjectItem[]>([])
  const [snapshot, setSnapshot]         = useState<WorkflowSnapshot | null>(null)
  const [sessionId]                     = useState(() => crypto.randomUUID())
  const [workflowId]                    = useState(() => crypto.randomUUID())
  const [started, setStarted]           = useState(false)
  const [projectName, setProjectName]   = useState("")
  const [projectPath, setProjectPath]   = useState("")
  const [roleStatus, setRoleStatus]     = useState<string | null>(null)
  const [showHelp, setShowHelp]         = useState(false)
  const [ptyStatus, setPtyStatus]       = useState<PtyStatus>("disconnected")
  const [installPhase, setInstallPhase] = useState<InstallPhase>("idle")
  const [installError, setInstallError] = useState<string | null>(null)
  const [depResult, setDepResult]       = useState<DepCheckResult | null>(null)
  // 保存 opts 用于错误重试时复原选项
  const [lastInstallOpts, setLastInstallOpts] = useState<{ installCodex: boolean; installGemini: boolean; installAllInOne: boolean; installSuperpowers: boolean }>({ installCodex: false, installGemini: false, installAllInOne: false, installSuperpowers: false })
  // 等待输入指令的阶段（点击"开始"后展开输入框）
  const [pendingRole, setPendingRole]   = useState<BmadRole | null>(null)
  const [pendingMsg, setPendingMsg]     = useState("")
  const [isPlain, setIsPlain]           = useState(false)  // 普通任务模式（无 BMAD 工作流）
  const [showExitConfirm, setShowExitConfirm]     = useState(false)
  const [isFileBrowserOpen, setIsFileBrowserOpen] = useState(false)
  const pendingInputRef = useRef<HTMLInputElement>(null)
  const terminalRef     = useRef<TerminalHandle>(null)

  // ── 启动时加载历史项目 ──
  useEffect(() => {
    window.bmad.storage.listProjects()
      .then(setProjects)
      .catch(() => setProjects([]))
  }, [])

  // ── 删除历史记录 ──
  async function handleDeleteProject(item: StorageProjectItem) {
    await window.bmad.storage.deleteProject(item.path)
    setProjects(prev => prev.filter(p => p.path !== item.path))
  }

  // ── 全局监听器（PTY 退出 + 工作流快照）──
  useEffect(() => {
    const offExit = window.bmad.pty.onExit((ev) => {
      if (ev.sessionId === sessionId) setPtyStatus("exited")
    })
    const offSnapshot = window.bmad.workflow.onSnapshot((snap) => {
      setSnapshot(snap)
      const cfg = ROLE_CONFIGS[snap.currentRole]
      setRoleStatus(`已切换：${cfg.emoji} ${cfg.label}`)
      setTimeout(() => setRoleStatus(null), 3000)
    })
    return () => { offExit(); offSnapshot() }
  }, [sessionId])

  // ── 启动 PTY + 工作流（新建/恢复共用）──
  async function launchSession(name: string, pPath: string, initialRole: BmadRole = "brainstorm") {
    await window.bmad.workflow.start({ workflowId, projectName: name, projectPath: pPath, initialRole })
    await window.bmad.pty.spawn({ sessionId, cwd: pPath })
    setPtyStatus("connected")
    // 统一用 claude 启动：有历史会话时 Claude Code 会自动提示恢复，无历史则新建
    await window.bmad.pty.write({ sessionId, data: "claude\r" })
    setStarted(true)
    setScreen("session")
  }

  // ── 普通任务：跳过安装和工作流，直接启动 ──
  async function launchPlainSession(pPath: string) {
    const name = pPath.split(/[\\/]/).pop() || "任务"
    setProjectName(name)
    setProjectPath(pPath)
    // 写入历史记录，普通任务标记 isPlain
    await window.bmad.storage.saveProject({ id: sessionId, name, path: pPath, isPlain: true }).catch(() => {})
    await window.bmad.pty.spawn({ sessionId, cwd: pPath })
    setPtyStatus("connected")
    await window.bmad.pty.write({ sessionId, data: "claude\r" })
    setIsPlain(true)
    setStarted(true)
    setScreen("session")
  }

  // ── 普通任务（含可选工具安装）：检查依赖 → 安装可选工具 → 启动 ──
  async function handlePlainStart(pPath: string, opts: { installCodex: boolean; installGemini: boolean; installAllInOne: boolean; installSuperpowers: boolean }) {
    if (!pPath.trim()) return
    setInstallError(null)
    setDepResult(null)
    setLastInstallOpts(opts)

    try {
      // 1. 检查依赖
      setInstallPhase("checking-deps")
      const deps = await window.bmad.deps.check()
      setDepResult(deps)

      if (!deps.node.installed || !deps.npm.installed) {
        setInstallError("未检测到 Node.js / npm，请先从 https://nodejs.org 安装")
        setInstallPhase("error")
        return
      }

      // 2. Claude Code CLI（必需）
      if (!deps.claude.installed) {
        setInstallPhase("installing-claude")
        const r = await window.bmad.deps.installClaude()
        if (!r.ok) { setInstallError(r.error ?? "Claude Code CLI 安装失败"); setInstallPhase("error"); return }
      }

      // 3. 可选工具
      if ((opts.installCodex && !deps.codex.installed) || (opts.installGemini && !deps.gemini.installed)) {
        setInstallPhase("installing-optional")
        await Promise.allSettled([
          opts.installCodex  && !deps.codex.installed  ? window.bmad.deps.installCodex()  : Promise.resolve(),
          opts.installGemini && !deps.gemini.installed ? window.bmad.deps.installGemini() : Promise.resolve(),
        ])
      }

      // 4. All-in-One 多模型环境
      if (opts.installAllInOne && !deps.allInOne.installed) {
        setInstallPhase("installing-all-in-one")
        const r = await window.bmad.deps.installAllInOne()
        if (!r.ok) { setInstallError(r.error ?? "All-in-One 环境配置失败"); setInstallPhase("error"); return }
      }

      // 5. Superpowers（项目级 skill，失败不中断流程）
      if (opts.installSuperpowers) {
        setInstallPhase("installing-optional")
        await window.bmad.deps.installSuperpowers({ projectPath: pPath }).catch(() => {})
      }

      setInstallPhase("done")
      await launchPlainSession(pPath)
    } catch (err: unknown) {
      setInstallError(err instanceof Error ? err.message : String(err))
      setInstallPhase("error")
    }
  }

  // ── 新建项目：检查依赖 → 安装 Claude（如缺失）→ 选装 Codex/Gemini → 安装 BMAD → 启动 ──
  async function handleStart(opts: { installCodex: boolean; installGemini: boolean; installAllInOne: boolean; installSuperpowers: boolean } = { installCodex: false, installGemini: false, installAllInOne: false, installSuperpowers: false }) {
    if (!projectName.trim() || !projectPath.trim()) return

    setInstallError(null)
    setDepResult(null)
    setLastInstallOpts(opts)

    try {
      // 1. 检查所有依赖（含可选工具）
      setInstallPhase("checking-deps")
      const deps = await window.bmad.deps.check()
      setDepResult(deps)

      if (!deps.node.installed || !deps.npm.installed) {
        setInstallError("未检测到 Node.js / npm，请先从 https://nodejs.org 安装")
        setInstallPhase("error")
        return
      }

      // 2. Claude Code CLI（必需）
      if (!deps.claude.installed) {
        setInstallPhase("installing-claude")
        const r = await window.bmad.deps.installClaude()
        if (!r.ok) {
          setInstallError(r.error ?? "Claude Code CLI 安装失败")
          setInstallPhase("error")
          return
        }
      }

      // 3. 可选工具（失败不中断流程）
      if ((opts.installCodex && !deps.codex.installed) || (opts.installGemini && !deps.gemini.installed)) {
        setInstallPhase("installing-optional")
        await Promise.allSettled([
          opts.installCodex  && !deps.codex.installed  ? window.bmad.deps.installCodex()  : Promise.resolve(),
          opts.installGemini && !deps.gemini.installed ? window.bmad.deps.installGemini() : Promise.resolve(),
        ])
      }

      // 4. All-in-One 多模型环境（已配置则跳过）
      if (opts.installAllInOne && !deps.allInOne.installed) {
        setInstallPhase("installing-all-in-one")
        const r = await window.bmad.deps.installAllInOne()
        if (!r.ok) {
          setInstallError(r.error ?? "All-in-One 环境配置失败")
          setInstallPhase("error")
          return
        }
      }

      // 5. Superpowers（项目级 skill，失败不中断流程）
      if (opts.installSuperpowers) {
        setInstallPhase("installing-optional")
        await window.bmad.deps.installSuperpowers({ projectPath }).catch(() => {})
      }

      // 6. 安装 BMAD-METHOD 工作流文件
      setInstallPhase("installing")
      const result = await window.bmad.installer.install({ projectPath, projectName })
      if (!result.ok) {
        setInstallError(result.error ?? "安装失败，请检查网络连接")
        setInstallPhase("error")
        return
      }

      setInstallPhase("done")
      await launchSession(projectName, projectPath, "brainstorm")
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setInstallError(msg)
      setInstallPhase("error")
    }
  }

  // ── 恢复历史会话（跳过安装，用 claude --resume 恢复上次对话）──
  async function handleResume(item: StorageProjectItem) {
    setProjectName(item.name)
    setProjectPath(item.path)
    if (item.isPlain) {
      // 普通任务：直接启动 PTY，无工作流
      await launchPlainSession(item.path)
    } else {
      const role = (item.lastRole as BmadRole | undefined) ?? "brainstorm"
      await launchSession(item.name, item.path, role)
    }
  }

  // ── 保存当前会话：通过 /rename 命名 Claude Code 会话 ──
  async function handleSaveSession() {
    if (!projectName || ptyStatus !== "connected") return
    await window.bmad.pty.write({ sessionId, data: `/rename ${projectName}\r` })
  }

  // ── 退出项目：终止 PTY、重置状态、返回选择页 ──
  async function doExit(save: boolean) {
    if (save) await window.bmad.pty.write({ sessionId, data: `/rename ${projectName}\r` })
    await window.bmad.pty.kill({ sessionId })
    // 重置所有会话状态
    setShowExitConfirm(false)
    setStarted(false)
    setSnapshot(null)
    setPtyStatus("disconnected")
    setProjectName("")
    setProjectPath("")
    setIsPlain(false)
    setIsFileBrowserOpen(false)
    setInstallPhase("idle")
    setInstallError(null)
    setDepResult(null)
    setPendingRole(null)
    setPendingMsg("")
    // 刷新项目列表后跳回选择页
    const updated = await window.bmad.storage.listProjects().catch(() => [] as StorageProjectItem[])
    setProjects(updated)
    setScreen("picker")
  }

  // ── 加载历史：通过 /resume 调出 Claude Code 内置会话列表，随后聚焦终端 ──
  async function handleLoadHistory() {
    if (ptyStatus !== "connected") return
    await window.bmad.pty.write({ sessionId, data: "/resume\r" })
    // 等待 /resume UI 渲染后聚焦终端，使方向键立即生效
    setTimeout(() => terminalRef.current?.focus(), 50)
  }

  // ── 推进到下一阶段 ──
  async function handleNext() {
    if (!snapshot) return
    await window.bmad.workflow.sendEvent({ workflowId, event: { type: "NEXT" } })
  }

  // ── 手动切换角色 ──
  async function handleRoleSwitch(target: BmadRole) {
    if (!snapshot || target === "done" || target === "failed") return
    await window.bmad.workflow.sendEvent({
      workflowId, event: { type: "SWITCH_ROLE", target },
    })
  }

  // ── 点击"开始"：展开输入框 ──
  function handleRolePending(role: BmadRole) {
    setPendingRole(role)
    setPendingMsg("")
    // 下一帧聚焦输入框
    setTimeout(() => pendingInputRef.current?.focus(), 50)
  }

  // ── 确认开始：切换角色 + 可选地发送初始指令 ──
  async function handleRoleConfirm() {
    if (!pendingRole) return
    const msg = pendingMsg.trim()
    setPendingRole(null)
    setPendingMsg("")
    // 将初始指令作为 $ARGUMENTS 注入 slash command，一次性发送
    await window.bmad.workflow.sendEvent({
      workflowId,
      event: { type: "SWITCH_ROLE", target: pendingRole, initialMessage: msg || undefined },
    })
  }

  const showInstallScreen = installPhase !== "idle" && installPhase !== "done"

  // ── 项目选择页（启动页，无侧边栏）──
  if (screen === "picker") {
    return (
      <>
        {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
        <ProjectPickerScreen
          projects={projects}
          onResume={handleResume}
          onDelete={(item) => void handleDeleteProject(item)}
          onNew={() => setScreen("intake")}
          onNewPlain={() => setScreen("plain")}
          onHelp={() => setShowHelp(true)}
        />
      </>
    )
  }

  // ── 普通任务表单（无 BMAD，仅填写路径）──
  if (screen === "plain") {
    return (
      <div className="h-screen bg-base text-text font-sans flex flex-col">
        {showInstallScreen ? (
          <InstallScreen
            projectName={projectPath.split("/").pop() || "任务"}
            projectPath={projectPath}
            phase={installPhase}
            error={installError}
            depResult={depResult}
            onRetry={() => void handlePlainStart(projectPath, lastInstallOpts)}
          />
        ) : (
          <PlainIntakeForm
            onBack={() => setScreen("picker")}
            onStart={(path, opts) => {
              setProjectPath(path)
              void handlePlainStart(path, opts)
            }}
          />
        )}
      </div>
    )
  }

  // ── 新建/安装页（无侧边栏，居中表单）──
  if (screen === "intake") {
    return (
      <div className="h-screen bg-base text-text font-sans flex flex-col">
        {showInstallScreen ? (
          <InstallScreen
            projectName={projectName}
            projectPath={projectPath}
            phase={installPhase}
            error={installError}
            depResult={depResult}
            onRetry={() => void handleStart(lastInstallOpts)}
          />
        ) : (
          <IntakeForm
            projectName={projectName}
            projectPath={projectPath}
            onNameChange={setProjectName}
            onPathChange={setProjectPath}
            onStart={(opts) => void handleStart(opts)}
            onBack={() => setScreen("picker")}
          />
        )}
      </div>
    )
  }

  // ── 普通任务会话（无侧边栏，全屏终端）──
  if (isPlain) {
    return (
      <div className="flex h-screen flex-col bg-base text-text font-sans">
        {showExitConfirm && (
          <ExitConfirmModal
            onSaveExit={() => void doExit(true)}
            onExit={() => void doExit(false)}
            onCancel={() => setShowExitConfirm(false)}
          />
        )}
        <div className="h-9 bg-crust border-b border-surface0 flex items-center px-4 gap-3 shrink-0">
          <span className="text-subtext text-xs">{projectName}</span>
          <span className="text-surface1">·</span>
          <span className="text-overlay0 text-xs">普通任务</span>
          <span className="flex-1" />
          <button
            onClick={() => void handleLoadHistory()}
            disabled={ptyStatus !== "connected"}
            title="加载历史会话 (/resume)"
            className="text-overlay0 hover:text-sapphire transition-colors disabled:opacity-30
                       text-xs px-2 py-0.5 rounded border border-transparent
                       hover:border-sapphire/30 flex items-center gap-1"
          >
            <span>🕒</span><span>加载历史</span>
          </button>
          <button
            onClick={() => void handleSaveSession()}
            disabled={ptyStatus !== "connected"}
            title={`保存会话 (/rename ${projectName})`}
            className="text-overlay0 hover:text-mauve transition-colors disabled:opacity-30
                       text-xs px-2 py-0.5 rounded border border-transparent
                       hover:border-mauve/30 flex items-center gap-1"
          >
            <span>💾</span><span>保存</span>
          </button>
          <button
            onClick={() => setShowExitConfirm(true)}
            title="退出项目"
            className="text-overlay0 hover:text-red transition-colors
                       text-xs px-2 py-0.5 rounded border border-transparent
                       hover:border-red/30 flex items-center gap-1"
          >
            <span>✕</span><span>退出</span>
          </button>
          <button
            onClick={() => setIsFileBrowserOpen(v => !v)}
            title="文件浏览器"
            className={[
              "text-xs px-2 py-0.5 rounded border transition-colors flex items-center gap-1",
              isFileBrowserOpen
                ? "border-sapphire/50 text-sapphire bg-sapphire/10"
                : "border-transparent text-overlay0 hover:text-sapphire hover:border-sapphire/30",
            ].join(" ")}
          >
            <span>📁</span>
          </button>
          <PtyIndicator status={ptyStatus} />
        </div>
        <div className="flex flex-1 overflow-hidden">
          <TerminalView ref={terminalRef} sessionId={sessionId} started={started} />
          <FileBrowser isOpen={isFileBrowserOpen} onClose={() => setIsFileBrowserOpen(false)} rootPath={projectPath} />
        </div>
      </div>
    )
  }

  // ── BMAD 会话页（侧边栏 + 终端）──
  return (
    <div className="flex h-screen bg-base text-text font-sans">
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
      {showExitConfirm && (
        <ExitConfirmModal
          onSaveExit={() => void doExit(true)}
          onExit={() => void doExit(false)}
          onCancel={() => setShowExitConfirm(false)}
        />
      )}

      {/* ── 左侧：BMAD 工作流面板 ── */}
      <aside className="w-60 flex flex-col bg-mantle border-r border-surface0 shrink-0">

        <div className="px-4 py-4 border-b border-surface0 flex items-start justify-between">
          <div>
            <h1 className="text-mauve font-bold text-base tracking-tight">云服务流程工具</h1>
            <p className="text-overlay0 text-xs mt-0.5">AI 驱动的敏捷开发</p>
          </div>
          <button
            onClick={() => setShowHelp(true)}
            title="使用指南"
            className="text-overlay0 hover:text-lavender transition-colors text-sm font-semibold
                       w-6 h-6 rounded-full border border-surface1 hover:border-lavender/50
                       flex items-center justify-center shrink-0 mt-0.5"
          >
            ?
          </button>
        </div>

        <nav className="flex flex-col gap-1 p-2 flex-1 overflow-y-auto">
          {ROLE_SEQUENCE.map((role) => {
            const cfg       = ROLE_CONFIGS[role]
            const isCur     = snapshot?.currentRole === role
            const curIdx    = snapshot ? ROLE_SEQUENCE.indexOf(snapshot.currentRole) : -1
            const roleIdx   = ROLE_SEQUENCE.indexOf(role)
            const isDone    = curIdx > roleIdx
            // 允许当前角色和其他角色都显示"开始"按钮
            const canSwitch = started && role !== "done" && role !== "failed"
            const isPending = pendingRole === role

            return (
              <div key={role} className="flex flex-col rounded-lg overflow-hidden">

                {/* 阶段行 */}
                <div
                  className={[
                    "flex items-center gap-2.5 px-3 py-2 group",
                    isCur      ? "bg-surface0 text-text"  : "",
                    isPending  ? "bg-surface0/60 text-text": "",
                    isDone     ? "text-green"              : "",
                    !isCur && !isDone && !isPending ? "text-overlay0" : "",
                  ].join(" ")}
                >
                  <span className="text-lg leading-none">{cfg.emoji}</span>
                  <span className="flex flex-col min-w-0 flex-1">
                    <span className="text-sm font-semibold truncate">{cfg.label}</span>
                    <span className="text-xs opacity-60 truncate">{cfg.description}</span>
                  </span>

                  {isCur && !isPending && (
                    <span className="w-1.5 h-1.5 rounded-full bg-mauve shrink-0" />
                  )}

                  {/* 已完成阶段：始终显示"重新进入"；当前/未来阶段：hover 时显示"开始" */}
                  {canSwitch && !isPending && (
                    <button
                      onClick={() => handleRolePending(role)}
                      className={[
                        "text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0",
                        "border transition-opacity",
                        isDone
                          ? "opacity-100 border-green/50 text-green hover:bg-green/10"
                          : "opacity-0 group-hover:opacity-100 border-mauve/50 text-mauve hover:bg-mauve/10",
                      ].join(" ")}
                    >
                      {isDone ? "重新进入" : "开始"}
                    </button>
                  )}

                  {/* 取消按钮：展开状态 */}
                  {isPending && (
                    <button
                      onClick={() => { setPendingRole(null); setPendingMsg("") }}
                      className="text-overlay0 hover:text-text text-xs px-1 shrink-0"
                    >
                      ✕
                    </button>
                  )}
                </div>

                {/* PM 阶段：线框图快捷按钮（当前阶段且未展开输入框时显示）*/}
                {isCur && role === "pm" && !isPending && (
                  <div className="px-3 pb-2.5 pt-1 flex flex-col gap-1.5 bg-surface0/40">
                    <button
                      onClick={() => void window.bmad.pty.write({ sessionId, data: "/bmad-generate-wireframe\r" })}
                      className="w-full py-1.5 text-[10px] border border-surface1 rounded
                                 text-subtext hover:text-text hover:border-mauve/50 transition-colors"
                    >
                      ◻ 生成线框图
                    </button>
                    <button
                      onClick={() => void window.bmad.pty.write({ sessionId, data: "/bmad-save-wireframe\r" })}
                      className="w-full py-1.5 text-[10px] border border-surface1 rounded
                                 text-subtext hover:text-text hover:border-green/50 transition-colors"
                    >
                      💾 保存线框图
                    </button>
                  </div>
                )}

                {/* 内联输入框（展开时显示） */}
                {isPending && (
                  <div className="px-3 pb-2.5 flex flex-col gap-1.5 bg-surface0/60">
                    <input
                      ref={pendingInputRef}
                      value={pendingMsg}
                      onChange={(e) => setPendingMsg(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                          e.preventDefault()
                          void handleRoleConfirm()
                        }
                        if (e.key === "Escape") {
                          setPendingRole(null)
                          setPendingMsg("")
                        }
                      }}
                      placeholder="初始指令（可选）"
                      className="w-full bg-base border border-surface0 rounded-md px-2.5 py-1.5
                                 text-xs text-text placeholder:text-overlay0
                                 focus:outline-none focus:border-mauve transition-colors"
                    />
                    <button
                      onClick={() => void handleRoleConfirm()}
                      className="w-full py-1.5 bg-mauve text-crust rounded-md text-xs font-bold
                                 hover:opacity-90 transition-opacity"
                    >
                      确认开始 →
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </nav>

        <div className="p-3 border-t border-surface0 flex flex-col gap-2">
          {started && snapshot && snapshot.currentRole !== "done" && (
            <button
              onClick={handleNext}
              className="w-full py-2 rounded-lg border border-mauve text-mauve text-sm font-semibold hover:bg-mauve/10 transition-colors"
            >
              推进下一阶段 →
            </button>
          )}
          {snapshot?.isManualLock && (
            <p className="text-yellow text-xs text-center">🔒 手动锁定，自动推进已暂停</p>
          )}
          {roleStatus && (
            <p className="text-green text-xs text-center animate-pulse">{roleStatus}</p>
          )}
        </div>
      </aside>

      {/* ── 右侧：主内容区 ── */}
      <main className="flex-1 flex flex-col overflow-hidden">

        {started && snapshot && (
          <div className="h-9 bg-crust border-b border-surface0 flex items-center px-4 gap-3 shrink-0">
            <span className="text-subtext text-xs">{projectName}</span>
            <span className="text-surface1">·</span>
            <span className="text-xs font-medium">
              {ROLE_CONFIGS[snapshot.currentRole].emoji}{" "}
              <span className="text-mauve">{ROLE_CONFIGS[snapshot.currentRole].label}</span>
            </span>
            <span className="flex-1" />
            {snapshot.isManualLock && (
              <span className="text-yellow text-xs">🔒 手动模式</span>
            )}
            {/* 加载历史：调出 Claude Code 内置 /resume 会话列表 */}
            <button
              onClick={() => void handleLoadHistory()}
              disabled={ptyStatus !== "connected"}
              title="加载历史会话 (/resume)"
              className="text-overlay0 hover:text-sapphire transition-colors disabled:opacity-30
                         text-xs px-2 py-0.5 rounded border border-transparent
                         hover:border-sapphire/30 flex items-center gap-1"
            >
              <span>🕒</span>
              <span>加载历史</span>
            </button>
            {/* 修复命令文件：重新生成 .claude/commands/bmad-*.md（无需网络）*/}
            <button
              onClick={() => void window.bmad.installer.repairCommands({ projectPath, projectName })}
              title="重新生成 BMAD 命令文件（修复 Unknown skill 错误）"
              className="text-overlay0 hover:text-yellow transition-colors
                         text-xs px-2 py-0.5 rounded border border-transparent
                         hover:border-yellow/30 flex items-center gap-1"
            >
              <span>🔧</span>
              <span>修复命令</span>
            </button>
            {/* 保存会话按钮：向 Claude 发送 /rename 命名当前对话 */}
            <button
              onClick={() => void handleSaveSession()}
              disabled={ptyStatus !== "connected"}
              title={`保存会话 (/rename ${projectName})`}
              className="text-overlay0 hover:text-mauve transition-colors disabled:opacity-30
                         text-xs px-2 py-0.5 rounded border border-transparent
                         hover:border-mauve/30 flex items-center gap-1"
            >
              <span>💾</span>
              <span>保存</span>
            </button>
            {/* 退出项目：弹出确认框后终止 PTY 并返回选择页 */}
            <button
              onClick={() => setShowExitConfirm(true)}
              title="退出项目"
              className="text-overlay0 hover:text-red transition-colors
                         text-xs px-2 py-0.5 rounded border border-transparent
                         hover:border-red/30 flex items-center gap-1"
            >
              <span>✕</span>
              <span>退出</span>
            </button>
            <button
              onClick={() => setIsFileBrowserOpen(v => !v)}
              title="文件浏览器"
              className={[
                "text-xs px-2 py-0.5 rounded border transition-colors flex items-center gap-1",
                isFileBrowserOpen
                  ? "border-sapphire/50 text-sapphire bg-sapphire/10"
                  : "border-transparent text-overlay0 hover:text-sapphire hover:border-sapphire/30",
              ].join(" ")}
            >
              <span>📁</span>
            </button>
            <PtyIndicator status={ptyStatus} />
          </div>
        )}

        {/* xterm.js 终端 + 右侧可折叠文件浏览器 */}
        <div className="flex flex-1 overflow-hidden">
          <TerminalView ref={terminalRef} sessionId={sessionId} started={started} />
          <FileBrowser isOpen={isFileBrowserOpen} onClose={() => setIsFileBrowserOpen(false)} rootPath={projectPath} />
        </div>
      </main>
    </div>
  )
}

// ============================================================
// xterm.js 终端组件
// ============================================================

interface TerminalHandle { focus(): void }

const TerminalView = forwardRef<TerminalHandle, { sessionId: string; started: boolean }>(
function TerminalView({ sessionId, started }, ref) {
  const containerRef  = useRef<HTMLDivElement>(null)
  const termRef       = useRef<Terminal | null>(null)
  const fitRef        = useRef<FitAddon | null>(null)
  const resizeTimer   = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 暴露 focus() 给父组件（用于按钮点击后聚焦终端）
  useImperativeHandle(ref, () => ({
    focus: () => termRef.current?.focus(),
  }))

  // 检查是否在底部
  const checkAtBottom = useCallback(() => {
    const term = termRef.current
    if (!term) return true
    const buf = term.buffer.active
    return buf.viewportY >= buf.length - term.rows
  }, [])

  // 初始化 Terminal
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const term = new Terminal({
      theme:      MOCHA_THEME,
      fontFamily: "JetBrains Mono, Cascadia Code, Menlo, monospace",
      fontSize:   14,
      lineHeight: 1.2,
      cursorBlink: true,
      allowTransparency: false,
      scrollback: 5000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    fit.fit()

    // 添加自定义键盘事件处理器以支持复制粘贴
    term.attachCustomKeyEventHandler((e) => {
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0
      const modKey = isMac ? e.metaKey : e.ctrlKey

      // 复制: Cmd+C (Mac) / Ctrl+C (Windows/Linux)
      if (modKey && e.key === 'c' && e.type === 'keydown') {
        const selection = term.getSelection()
        if (selection) {
          navigator.clipboard.writeText(selection)
          return false // 阻止默认行为
        }
        // 没有选中文本时，允许发送 Ctrl+C 信号给 PTY
        return true
      }

      // 粘贴: Cmd+V (Mac) / Ctrl+V (Windows/Linux)
      if (modKey && e.key === 'v' && e.type === 'keydown') {
        // 阻止默认行为，防止浏览器原生粘贴
        e.preventDefault()
        navigator.clipboard.readText().then(text => {
          if (text) {
            term.paste(text)
          }
        })
        return false
      }

      // 全选: Cmd+A (Mac) / Ctrl+A (Windows/Linux)
      if (modKey && e.key === 'a' && e.type === 'keydown') {
        term.selectAll()
        return false
      }

      return true // 允许其他按键通过
    })

    termRef.current = term
    fitRef.current  = fit

    return () => {
      term.dispose()
      termRef.current = null
      fitRef.current  = null
    }
  }, [])

  // 监听容器尺寸变化 → 防抖 fit + 通知 PTY resize
  // 防抖：避免面板动画期间高频 fit() 导致 xterm.js viewport 跳到顶部
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const observer = new ResizeObserver(() => {
      if (resizeTimer.current) clearTimeout(resizeTimer.current)
      resizeTimer.current = setTimeout(() => {
        const term = termRef.current
        const fit  = fitRef.current
        if (!fit || !term) return

        // 记录 fit 前是否在底部，fit 后恢复
        const buf = term.buffer.active
        const atBottom = buf.viewportY >= buf.length - term.rows
        fit.fit()
        if (atBottom) term.scrollToBottom()

        if (started) {
          void window.bmad.pty.resize({ sessionId, cols: term.cols, rows: term.rows })
        }
      }, 50)
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      if (resizeTimer.current) clearTimeout(resizeTimer.current)
    }
  }, [sessionId, started])

  // started 变为 true 后立即同步终端实际尺寸给 PTY
  // PTY 默认以 120×30 启动，不同步会导致 TUI 渲染在顶部区域
  useEffect(() => {
    if (!started) return
    const id = requestAnimationFrame(() => {
      const fit  = fitRef.current
      const term = termRef.current
      if (!fit || !term) return
      fit.fit()
      void window.bmad.pty.resize({ sessionId, cols: term.cols, rows: term.rows })
    })
    return () => cancelAnimationFrame(id)
  }, [started, sessionId])

  // PTY 数据 → 写入 xterm
  useEffect(() => {
    if (!started) return
    const off = window.bmad.pty.onData((ev) => {
      if (ev.sessionId === sessionId) {
        const term = termRef.current
        if (term) {
          const wasAtBottom = checkAtBottom()
          term.write(ev.data)
          // 如果之前在底部，新数据写入后保持滚动到底部
          if (wasAtBottom) {
            term.scrollToBottom()
          }
        }
      }
    })
    return () => off()
  }, [started, sessionId, checkAtBottom])

  // xterm 用户输入 → 写入 PTY
  useEffect(() => {
    const term = termRef.current
    if (!term || !started) return
    const d = term.onData((data) => {
      void window.bmad.pty.write({ sessionId, data })
    })
    return () => d.dispose()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, sessionId, termRef.current])

  return (
    <div className="relative flex-1 min-h-0 overflow-hidden">
      <div
        ref={containerRef}
        className="w-full h-full"
        style={{ padding: "4px" }}
      />
      {/* 跳转到底部按钮 - 始终显示 */}
      <button
        onClick={() => {
          termRef.current?.scrollToBottom()
        }}
        className="absolute bottom-4 right-4 px-3 py-1.5 bg-surface0 hover:bg-surface1
                   text-text text-xs font-medium rounded-lg border border-mauve/50
                   shadow-lg transition-all flex items-center gap-1.5 z-50"
        title="跳转到底部"
      >
        <span>↓</span>
        <span>跳转到底部</span>
      </button>
    </div>
  )
})

// ============================================================
// 安装进度界面
// ============================================================

interface InstallScreenProps {
  projectName: string
  projectPath: string
  phase:     InstallPhase
  error:     string | null
  depResult: DepCheckResult | null
  onRetry:   () => void
}

// 每个依赖项的显示行
function DepRow({ label, status, checking }: {
  label:    string
  status?:  { installed: boolean; version?: string }
  checking: boolean
}) {
  if (checking || !status) {
    return (
      <div className="flex items-center gap-2.5 text-sm text-subtext">
        <AnimatedDot index={0} />
        <span>{label}</span>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2.5 text-sm">
      <span className={status.installed ? "text-green" : "text-red"}>
        {status.installed ? "✓" : "✗"}
      </span>
      <span className={status.installed ? "text-subtext" : "text-red"}>{label}</span>
      {status.version && (
        <span className="text-overlay0 font-mono text-xs">{status.version}</span>
      )}
      {!status.installed && <span className="text-overlay0 text-xs">未安装</span>}
    </div>
  )
}

function InstallScreen({ projectName, projectPath, phase, error, depResult, onRetry }: InstallScreenProps) {
  const isError    = phase === "error"
  const isChecking = phase === "checking-deps"

  const title = {
    "checking-deps":        "检查环境依赖",
    "installing-claude":    "安装 Claude Code CLI",
    "installing-optional":  "安装可选工具",
    "installing-all-in-one":"配置 All-in-One 多模型环境",
    "installing":           "安装 BMAD-METHOD",
    "error":                "安装失败",
    "idle":                 "",
    "done":                 "",
  }[phase]

  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="w-full max-w-md bg-mantle rounded-2xl border border-surface0 p-8 flex flex-col gap-5">

        <div className="flex items-center gap-3">
          {isError ? <span className="text-2xl">❌</span> : <Spinner />}
          <div>
            <h2 className={`text-xl font-bold ${isError ? "text-red" : "text-mauve"}`}>{title}</h2>
            <p className="text-subtext text-xs mt-0.5">{projectName}</p>
          </div>
        </div>

        <div className="bg-base rounded-lg px-3 py-2 font-mono text-xs text-overlay0 truncate">
          {projectPath}
        </div>

        {/* 依赖状态行 */}
        <div className="flex flex-col gap-2">
          <DepRow label="Node.js" status={depResult?.node}   checking={isChecking && !depResult} />
          <DepRow label="npm"     status={depResult?.npm}    checking={isChecking && !depResult} />
          <DepRow
            label={phase === "installing-claude" ? "Claude Code CLI（安装中…）" : "Claude Code CLI"}
            status={depResult?.claude}
            checking={isChecking && !depResult}
          />
          {/* 可选工具：仅在已检测到（已安装或已选装）时显示 */}
          {depResult && (depResult.codex.installed || phase === "installing-optional" || phase === "installing-all-in-one") && (
            <DepRow
              label={phase === "installing-optional" ? "Codex CLI（安装中…）" : "Codex CLI"}
              status={depResult.codex}
              checking={false}
            />
          )}
          {depResult && (depResult.gemini.installed || phase === "installing-optional" || phase === "installing-all-in-one") && (
            <DepRow
              label={phase === "installing-optional" ? "Gemini CLI（安装中…）" : "Gemini CLI"}
              status={depResult.gemini}
              checking={false}
            />
          )}
          {/* uvx + All-in-One 环境：仅在已检测到或正在配置时显示 */}
          {depResult && (depResult.allInOne.installed || phase === "installing-all-in-one") && (
            <>
              <DepRow
                label={phase === "installing-all-in-one" && !depResult.uvx.installed ? "uvx（安装中…）" : "uvx"}
                status={depResult.uvx}
                checking={false}
              />
              <DepRow
                label={phase === "installing-all-in-one" ? "All-in-One 多模型环境（配置中…）" : "All-in-One 多模型环境"}
                status={depResult.allInOne}
                checking={false}
              />
            </>
          )}
        </div>

        {/* BMAD 安装步骤（仅在 installing 阶段显示）*/}
        {phase === "installing" && (
          <div className="flex flex-col gap-2 pt-1 border-t border-surface0">
            {["初始化项目目录", "拉取 BMAD-METHOD 配置", "配置 Claude Code 命令"].map((step, i) => (
              <div key={i} className="flex items-center gap-2.5 text-sm">
                <AnimatedDot index={i} />
                <span className="text-subtext">{step}</span>
              </div>
            ))}
          </div>
        )}

        {/* 错误信息 + 重试 */}
        {isError && (
          <div className="flex flex-col gap-3">
            <p className="text-red text-sm bg-red/10 rounded-lg px-3 py-2 leading-relaxed">{error}</p>
            <button
              onClick={onRetry}
              className="w-full py-2.5 bg-mauve text-crust rounded-lg font-bold text-sm hover:opacity-90 transition-opacity"
            >
              重试
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function Spinner() {
  return (
    <div
      className="w-7 h-7 rounded-full border-2 border-surface0 border-t-mauve shrink-0"
      style={{ animation: "spin 0.8s linear infinite" }}
    />
  )
}

function AnimatedDot({ index }: { index: number }) {
  return (
    <span
      className="inline-block w-1.5 h-1.5 rounded-full bg-mauve shrink-0"
      style={{ animation: `bounce 1.2s ease-in-out ${index * 200}ms infinite` }}
    />
  )
}

// ============================================================
// PTY 状态指示器
// ============================================================

const PTY_STATUS_CONFIG: Record<PtyStatus, { dot: string; label: string; pulse: boolean }> = {
  disconnected: { dot: "bg-surface1", label: "未连接",        pulse: false },
  connected:    { dot: "bg-green",    label: "Claude 运行中", pulse: true  },
  exited:       { dot: "bg-red",      label: "已断开",        pulse: false },
}

function PtyIndicator({ status }: { status: PtyStatus }) {
  const cfg = PTY_STATUS_CONFIG[status]
  return (
    <div className="flex items-center gap-1.5 text-xs text-subtext select-none">
      <span className={["w-2 h-2 rounded-full shrink-0", cfg.dot, cfg.pulse ? "animate-pulse" : ""].join(" ")} />
      <span>{cfg.label}</span>
    </div>
  )
}

// ============================================================
// 项目导入表单
// ============================================================

interface IntakeFormProps {
  projectName: string
  projectPath: string
  onNameChange: (v: string) => void
  onPathChange: (v: string) => void
  onStart: (opts: { installCodex: boolean; installGemini: boolean; installAllInOne: boolean; installSuperpowers: boolean }) => void
  onBack: () => void
}

function IntakeForm({
  projectName, projectPath,
  onNameChange, onPathChange, onStart, onBack,
}: IntakeFormProps) {
  const [installCodex,       setInstallCodex]       = useState(false)
  const [installGemini,      setInstallGemini]      = useState(false)
  const [installAllInOne,    setInstallAllInOne]    = useState(false)
  const [installSuperpowers, setInstallSuperpowers] = useState(false)
  const canStart = projectName.trim().length > 0 && projectPath.trim().length > 0

  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="w-full max-w-md bg-mantle rounded-2xl border border-surface0 p-8 flex flex-col gap-5">

        <div className="flex items-start gap-3">
          <button
            onClick={onBack}
            className="mt-0.5 text-overlay0 hover:text-text transition-colors shrink-0"
            title="返回项目列表"
          >
            ←
          </button>
          <div>
            <h2 className="text-2xl font-bold text-mauve">新建 BMAD 项目</h2>
            <p className="text-subtext text-sm mt-1">
              填写基本信息，将自动配置 BMAD-METHOD 并开启 AI 驱动的敏捷开发流程
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-subtext text-sm font-medium">项目名称</label>
          <input
            className="bg-base border border-surface0 rounded-lg px-4 py-2.5 text-text text-sm
                       focus:outline-none focus:border-mauve transition-colors placeholder:text-overlay0"
            value={projectName}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="例：我的电商平台"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-subtext text-sm font-medium">项目路径</label>
          <div className="flex gap-2">
            <input
              className="flex-1 bg-base border border-surface0 rounded-lg px-4 py-2.5 text-text text-sm
                         focus:outline-none focus:border-mauve transition-colors placeholder:text-overlay0 font-mono"
              value={projectPath}
              onChange={(e) => onPathChange(e.target.value)}
              placeholder="/Users/你/projects/my-app"
            />
            <button
              type="button"
              onClick={async () => {
                const dir = await window.bmad.dialog.openDir()
                if (dir) onPathChange(dir)
              }}
              title="浏览本地目录"
              className="px-3 py-2 bg-surface0 hover:bg-surface1 text-subtext hover:text-text
                         rounded-lg border border-surface0 transition-colors text-sm shrink-0"
            >
              📂
            </button>
          </div>
        </div>

        <p className="text-overlay0 text-xs -mt-1">
          📁 BMAD 生成的文档将写入 <code className="text-mauve">_bmad-output/</code>
        </p>

        {/* 可选工具 */}
        <div className="flex flex-col gap-2 pt-1 border-t border-surface0">
          <p className="text-overlay0 text-xs font-medium">可选工具（已安装则跳过）</p>
          <label className="flex items-center gap-2.5 cursor-pointer group">
            <input
              type="checkbox"
              checked={installCodex}
              // allInOne 勾选时 Codex 必须勾选，禁止取消
              onChange={(e) => { if (!installAllInOne) setInstallCodex(e.target.checked) }}
              className="w-4 h-4 accent-mauve rounded"
            />
            <span className={`text-sm transition-colors ${installAllInOne ? "text-subtext" : "group-hover:text-text text-subtext"}`}>
              Codex CLI
            </span>
            <span className="text-overlay0 text-xs font-mono">@openai/codex</span>
          </label>
          <label className="flex items-center gap-2.5 cursor-pointer group">
            <input
              type="checkbox"
              checked={installGemini}
              // allInOne 勾选时 Gemini 必须勾选，禁止取消
              onChange={(e) => { if (!installAllInOne) setInstallGemini(e.target.checked) }}
              className="w-4 h-4 accent-mauve rounded"
            />
            <span className={`text-sm transition-colors ${installAllInOne ? "text-subtext" : "group-hover:text-text text-subtext"}`}>
              Gemini CLI
            </span>
            <span className="text-overlay0 text-xs font-mono">@google/gemini-cli</span>
          </label>

          {/* 分隔线 */}
          <div className="w-full h-px bg-surface0 my-1" />
          <p className="text-overlay0 text-xs font-medium">多模型协作</p>

          {/* All-in-One 环境：勾选时自动勾选 Codex+Gemini */}
          <label className="flex items-start gap-2.5 cursor-pointer group mt-1">
            <input
              type="checkbox"
              checked={installAllInOne}
              onChange={(e) => {
                const checked = e.target.checked
                setInstallAllInOne(checked)
                if (checked) { setInstallCodex(true); setInstallGemini(true) }
              }}
              className="w-4 h-4 mt-0.5 accent-sapphire rounded"
            />
            <div className="flex flex-col gap-0.5">
              <span className="text-sapphire text-sm font-medium group-hover:brightness-110 transition-all">
                多模型协作环境
              </span>
              <span className="text-overlay0 text-xs">
                配置 Codex+Gemini MCP 服务与 Claude 协作（自动追加 CLAUDE.md 规范）
              </span>
            </div>
          </label>

          {/* 分隔线 */}
          <div className="w-full h-px bg-surface0 my-1" />
          <p className="text-overlay0 text-xs font-medium">技能增强</p>

          {/* Superpowers skill */}
          <label className="flex items-start gap-2.5 cursor-pointer group mt-1">
            <input
              type="checkbox"
              checked={installSuperpowers}
              onChange={(e) => setInstallSuperpowers(e.target.checked)}
              className="w-4 h-4 mt-0.5 accent-mauve rounded"
            />
            <div className="flex flex-col gap-0.5">
              <span className="text-subtext text-sm group-hover:text-text transition-colors">
                Superpowers
              </span>
              <span className="text-overlay0 text-xs">
                obra/superpowers · 增强 Claude 能力的 skill 包
              </span>
            </div>
          </label>
        </div>

        <button
          onClick={() => onStart({ installCodex, installGemini, installAllInOne, installSuperpowers })}
          disabled={!canStart}
          className="w-full py-3 bg-mauve text-crust rounded-lg font-bold text-sm
                     hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
        >
          配置并开始项目
        </button>
      </div>
    </div>
  )
}

// ============================================================
// 普通任务表单
// ============================================================

interface PlainIntakeFormProps {
  onBack:  () => void
  onStart: (path: string, opts: { installCodex: boolean; installGemini: boolean; installAllInOne: boolean; installSuperpowers: boolean }) => void
}

function PlainIntakeForm({ onBack, onStart }: PlainIntakeFormProps) {
  const [path,              setPath]              = useState("")
  const [installCodex,      setInstallCodex]      = useState(false)
  const [installGemini,     setInstallGemini]     = useState(false)
  const [installAllInOne,   setInstallAllInOne]   = useState(false)
  const [installSuperpowers,setInstallSuperpowers] = useState(false)
  const canStart = path.trim().length > 0

  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="w-full max-w-md bg-mantle rounded-2xl border border-surface0 p-8 flex flex-col gap-5">

        <div className="flex items-start gap-3">
          <button onClick={onBack} className="mt-0.5 text-overlay0 hover:text-text transition-colors shrink-0">←</button>
          <div>
            <h2 className="text-2xl font-bold text-text">普通任务</h2>
            <p className="text-subtext text-sm mt-1">直接在指定目录启动，无 BMAD 工作流</p>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-subtext text-sm font-medium">工作目录</label>
          <div className="flex gap-2">
            <input
              className="flex-1 bg-base border border-surface0 rounded-lg px-4 py-2.5 text-text text-sm
                         focus:outline-none focus:border-mauve transition-colors placeholder:text-overlay0 font-mono"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && canStart) onStart(path.trim(), { installCodex, installGemini, installAllInOne, installSuperpowers }) }}
              placeholder="/Users/你/projects/my-project"
              autoFocus
            />
            <button
              type="button"
              onClick={async () => {
                const dir = await window.bmad.dialog.openDir()
                if (dir) setPath(dir)
              }}
              title="浏览本地目录"
              className="px-3 py-2 bg-surface0 hover:bg-surface1 text-subtext hover:text-text
                         rounded-lg border border-surface0 transition-colors text-sm shrink-0"
            >
              📂
            </button>
          </div>
        </div>

        {/* 可选工具（与 BMAD 表单共享逻辑）*/}
        <div className="flex flex-col gap-2 pt-1 border-t border-surface0">
          <p className="text-overlay0 text-xs font-medium">可选工具（已安装则跳过）</p>
          <label className="flex items-center gap-2.5 cursor-pointer group">
            <input type="checkbox" checked={installCodex}
              onChange={(e) => { if (!installAllInOne) setInstallCodex(e.target.checked) }}
              className="w-4 h-4 accent-mauve rounded" />
            <span className="text-subtext text-sm group-hover:text-text transition-colors">Codex CLI</span>
            <span className="text-overlay0 text-xs font-mono">@openai/codex</span>
          </label>
          <label className="flex items-center gap-2.5 cursor-pointer group">
            <input type="checkbox" checked={installGemini}
              onChange={(e) => { if (!installAllInOne) setInstallGemini(e.target.checked) }}
              className="w-4 h-4 accent-mauve rounded" />
            <span className="text-subtext text-sm group-hover:text-text transition-colors">Gemini CLI</span>
            <span className="text-overlay0 text-xs font-mono">@google/gemini-cli</span>
          </label>
          <div className="w-full h-px bg-surface0 my-1" />
          <p className="text-overlay0 text-xs font-medium">多模型协作</p>
          <label className="flex items-start gap-2.5 cursor-pointer group mt-1">
            <input type="checkbox" checked={installAllInOne}
              onChange={(e) => {
                const checked = e.target.checked
                setInstallAllInOne(checked)
                if (checked) { setInstallCodex(true); setInstallGemini(true) }
              }}
              className="w-4 h-4 mt-0.5 accent-sapphire rounded" />
            <div className="flex flex-col gap-0.5">
              <span className="text-sapphire text-sm font-medium group-hover:brightness-110 transition-all">
                多模型协作环境
              </span>
              <span className="text-overlay0 text-xs">配置 Codex+Gemini MCP 服务与 Claude 协作</span>
            </div>
          </label>

          <div className="w-full h-px bg-surface0 my-1" />
          <p className="text-overlay0 text-xs font-medium">技能增强</p>
          <label className="flex items-start gap-2.5 cursor-pointer group mt-1">
            <input type="checkbox" checked={installSuperpowers}
              onChange={(e) => setInstallSuperpowers(e.target.checked)}
              className="w-4 h-4 mt-0.5 accent-mauve rounded" />
            <div className="flex flex-col gap-0.5">
              <span className="text-subtext text-sm group-hover:text-text transition-colors">Superpowers</span>
              <span className="text-overlay0 text-xs">obra/superpowers · 增强 Claude 能力的 skill 包</span>
            </div>
          </label>
        </div>

        <button
          onClick={() => onStart(path.trim(), { installCodex, installGemini, installAllInOne, installSuperpowers })}
          disabled={!canStart}
          className="w-full py-3 bg-surface1 text-text rounded-lg font-bold text-sm
                     hover:bg-surface0 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          启动 →
        </button>
      </div>
    </div>
  )
}

// ============================================================
// 项目选择页（启动首页）
// ============================================================

const ROLE_LABEL: Record<string, string> = {
  intake: "项目导入", brainstorm: "头脑风暴", analyst: "需求分析",
  pm: "产品规划", "ux-designer": "UX/UI 设计", architect: "架构设计",
  "epic-planner": "史诗规划", developer: "编码实现", qa: "质量审查", done: "已完成",
}

function getRelativeTime(ts: number): string {
  const diff = Date.now() - ts
  const days = Math.floor(diff / 86_400_000)
  if (days === 0) return "今天"
  if (days === 1) return "昨天"
  if (days < 7)   return `${days}天前`
  return new Date(ts).toLocaleDateString("zh-CN")
}

interface ProjectPickerScreenProps {
  projects:  StorageProjectItem[]
  onResume:  (item: StorageProjectItem) => void
  onDelete:  (item: StorageProjectItem) => void
  onNew:     () => void
  onNewPlain: () => void
  onHelp:    () => void
}

function ProjectPickerScreen({ projects, onResume, onDelete, onNew, onNewPlain, onHelp }: ProjectPickerScreenProps) {
  return (
    <div className="min-h-screen bg-base text-text flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-[640px] flex flex-col gap-8">

        {/* 标题区 */}
        <div className="relative text-center space-y-2">
          <h1 className="text-4xl font-bold text-mauve tracking-tight">云服务流程工具</h1>
          <p className="text-subtext">选择一个现有项目，或开启新的旅程</p>
          {/* 使用指南按钮 */}
          <button
            onClick={onHelp}
            title="使用指南"
            className="absolute right-0 top-0 text-overlay0 hover:text-lavender transition-colors text-sm font-semibold
                       w-7 h-7 rounded-full border border-surface1 hover:border-lavender/50
                       flex items-center justify-center"
          >
            ?
          </button>
        </div>

        {/* 项目列表卡片 */}
        <div className="bg-mantle rounded-2xl border border-surface0 overflow-hidden flex flex-col">
          {projects.length > 0 ? (
            <div className="max-h-[420px] overflow-y-auto">
              {projects.map((proj) => (
                <div
                  key={proj.id}
                  className="group flex items-center justify-between p-4 border-b border-surface0
                             last:border-0 hover:bg-surface0/50 transition-colors duration-150"
                >
                  <div className="flex flex-col gap-1 min-w-0 flex-1 pr-4">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-text truncate">{proj.name}</span>
                      {proj.lastRole && (
                        <span className="px-2 py-0.5 rounded-full text-[10px] bg-mauve/10
                                         text-mauve border border-mauve/20 shrink-0">
                          {ROLE_LABEL[proj.lastRole] ?? proj.lastRole}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      <code className="text-overlay0 truncate font-mono">{proj.path}</code>
                      <span className="text-surface1 shrink-0">·</span>
                      <span className="text-overlay0 shrink-0">{getRelativeTime(proj.updatedAt)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => onDelete(proj)}
                      title="删除记录"
                      className="opacity-0 group-hover:opacity-100 transition-opacity
                                 text-overlay0 hover:text-red text-sm px-1.5 py-1 rounded
                                 hover:bg-red/10 border border-transparent hover:border-red/30"
                    >
                      🗑️
                    </button>
                    <button
                      onClick={() => onResume(proj)}
                      className="px-4 py-1.5 rounded-lg border border-mauve text-mauve text-sm font-medium
                                 hover:bg-mauve hover:text-crust transition-all active:scale-95"
                    >
                      继续
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            /* 空状态 */
            <div className="py-16 flex flex-col items-center gap-4 text-overlay0">
              <svg className="w-14 h-14 opacity-20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14
                     0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                />
              </svg>
              <p className="text-sm">暂无历史项目</p>
            </div>
          )}

          {/* 底部操作区 */}
          <div className="p-4 bg-crust/50 border-t border-surface0 flex items-center gap-3 justify-center">
            <button
              onClick={onNew}
              className="flex items-center gap-2 px-6 py-2.5 bg-mauve text-crust font-bold
                         rounded-xl hover:opacity-90 transition-all active:scale-[0.98] text-sm"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
              </svg>
              新建 BMAD 项目
            </button>
            <button
              onClick={onNewPlain}
              className="flex items-center gap-2 px-6 py-2.5 bg-surface0 text-subtext font-medium
                         rounded-xl hover:bg-surface1 transition-all active:scale-[0.98] text-sm"
            >
              普通任务
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ============================================================
// 帮助/使用指南模态框
// ============================================================

// 各阶段可用指令配置（command, desc, 可选 note 标注适用条件）
const STAGE_COMMANDS: {
  stage: string; emoji: string; color: string; bg: string;
  desc: string;
  commands: { cmd: string; desc: string; note?: string }[]
}[] = [
  {
    stage: "任意阶段", emoji: "🌐", color: "text-overlay0", bg: "bg-surface0/30",
    desc: "随时可用",
    commands: [
      { cmd: "/bmad-help",  desc: "查看当前工作流下一步，或提问 BMAD 方法论相关问题" },
      { cmd: "/resume",     desc: "（Claude 内置）打开历史会话列表，切换/恢复对话" },
    ],
  },
  {
    stage: "头脑风暴", emoji: "💡", color: "text-yellow", bg: "bg-yellow/5",
    desc: "探索创意与方向",
    commands: [
      { cmd: "/bmad-brainstorming", desc: "启动互动头脑风暴会话，发散思维、探索产品方向" },
    ],
  },
  {
    stage: "需求分析", emoji: "🔍", color: "text-peach", bg: "bg-peach/5",
    desc: "BA 澄清与分析需求",
    commands: [
      { cmd: "/bmad-bmm-create-product-brief", desc: "通过协作发现流程生成产品简报（Product Brief）" },
    ],
  },
  {
    stage: "产品规划", emoji: "📝", color: "text-mauve", bg: "bg-mauve/5",
    desc: "PM 撰写 PRD",
    commands: [
      { cmd: "/bmad-bmm-create-prd",     desc: "从零创建产品需求文档（PRD）" },
      { cmd: "/bmad-generate-wireframe", desc: "根据当前对话内容生成文本线框图（Unicode 框线字符）", note: "侧边栏有快捷按钮" },
      { cmd: "/bmad-save-wireframe",     desc: "保存线框图到 _bmad-output/planning-artifacts/wireframe.md（Markdown 格式，UX 阶段可自动读取）", note: "侧边栏有快捷按钮" },
    ],
  },
  {
    stage: "UX/UI 设计", emoji: "🎨", color: "text-pink", bg: "bg-pink/5",
    desc: "交互设计与视觉规范",
    commands: [
      { cmd: "/bmad-bmm-create-ux-design", desc: "制定 UX 交互模式与设计规范文档" },
    ],
  },
  {
    stage: "架构设计", emoji: "🏗️", color: "text-sapphire", bg: "bg-sapphire/5",
    desc: "架构师制定技术方案",
    commands: [
      { cmd: "/bmad-bmm-create-architecture", desc: "创建技术架构方案设计文档" },
    ],
  },
  {
    stage: "史诗规划", emoji: "📚", color: "text-teal", bg: "bg-teal/5",
    desc: "分解故事并验证准备度",
    commands: [
      { cmd: "/bmad-create-epics-and-stories",      desc: "将需求拆解为 Epics 和 User Stories" },
      { cmd: "/bmad-check-implementation-readiness", desc: "检查 PRD / UX / 架构 / Epics 是否完备，验证开发就绪度" },
    ],
  },
  {
    stage: "编码实现", emoji: "💻", color: "text-green", bg: "bg-green/5",
    desc: "开发者实现功能代码",
    commands: [
      { cmd: "/bmad-sprint-planning",  desc: "从 Epics 生成 Sprint 计划与状态跟踪表" },
      { cmd: "/bmad-create-story",     desc: "为某个 Story 创建完整上下文文件，供后续实现使用" },
      { cmd: "/bmad-bmm-dev-story",    desc: "按 Story 规范文件执行代码实现（需指定 story 文件路径）" },
      { cmd: "/bmad-code-review",      desc: "对当前代码进行对抗性审查，精确定位问题" },
      { cmd: "/bmad-correct-course",   desc: "在 Sprint 执行中管理重大变更，调整方向" },
      { cmd: "/bmad-retrospective",    desc: "Epic 结束后复盘，提取经验教训" },
    ],
  },
  {
    stage: "质量审查", emoji: "✅", color: "text-green", bg: "bg-green/5",
    desc: "QA 验收与测试",
    commands: [
      { cmd: "/bmad-bmm-qa-generate-e2e-tests", desc: "为已有功能生成端到端（E2E）自动化测试用例" },
    ],
  },
]

function HelpModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-base/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-2xl bg-mantle rounded-2xl border border-surface0 max-h-[88vh] overflow-y-auto shadow-2xl flex flex-col text-text">

        {/* 顶栏（sticky）*/}
        <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-4 bg-mantle/95 backdrop-blur border-b border-surface0">
          <div>
            <h2 className="text-lg font-bold tracking-wide">使用指南</h2>
            <p className="text-overlay0 text-xs mt-0.5">各阶段可用指令一览</p>
          </div>
          <button
            onClick={onClose}
            className="flex items-center justify-center w-8 h-8 rounded-full text-subtext
                       hover:bg-surface0 hover:text-text transition-colors shrink-0"
          >
            ✕
          </button>
        </div>

        <div className="p-5 flex flex-col gap-4">

          {/* 阶段指令表 */}
          {STAGE_COMMANDS.map(({ stage, emoji, color, bg, desc, commands }) => (
            <section key={stage} className={`rounded-xl border border-surface0/60 overflow-hidden`}>
              {/* 阶段标题行 */}
              <div className={`flex items-center gap-2.5 px-4 py-2.5 ${bg} border-b border-surface0/40`}>
                <span className="text-base">{emoji}</span>
                <span className={`text-sm font-semibold ${color}`}>{stage}</span>
                <span className="text-overlay0 text-xs">— {desc}</span>
              </div>
              {/* 指令列表 */}
              <div className="divide-y divide-surface0/40">
                {commands.map(({ cmd, desc: cmdDesc, note }) => (
                  <div key={cmd} className="flex items-start gap-3 px-4 py-2.5 hover:bg-surface0/30 transition-colors">
                    <code className="text-mauve font-mono text-xs font-medium shrink-0 mt-0.5 min-w-0">{cmd}</code>
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <span className="text-subtext text-xs leading-relaxed">{cmdDesc}</span>
                      {note && (
                        <span className="text-overlay0 text-[10px]">💡 {note}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}

          {/* 新增功能迭代 */}
          <section className="rounded-xl border border-surface0/60 overflow-hidden">
            <div className="flex items-center gap-2.5 px-4 py-2.5 bg-yellow/5 border-b border-surface0/40">
              <span className="text-base">🔁</span>
              <span className="text-sm font-semibold text-yellow">新增功能迭代</span>
              <span className="text-overlay0 text-xs">— 已完成开发/测试后追加功能</span>
            </div>
            <div className="divide-y divide-surface0/40">
              {/* 路径一 */}
              <div className="px-4 py-3">
                <p className="text-xs font-semibold text-green mb-2">小功能 / 需求明确 → 直接开发</p>
                <div className="flex flex-col gap-1.5">
                  {[
                    ["史诗规划", "/bmad-create-story",              "为新功能创建 Story 文件"],
                    ["编码实现", "/bmad-bmm-dev-story",             "按 Story 文件实现代码"],
                    ["编码实现", "/bmad-code-review",               "审查新增代码"],
                    ["质量审查", "/bmad-bmm-qa-generate-e2e-tests", "补充 E2E 测试用例"],
                  ].map(([stage, cmd, desc]) => (
                    <div key={cmd} className="flex items-center gap-2">
                      <span className="text-overlay0 text-[10px] w-14 shrink-0">{stage}</span>
                      <code className="text-mauve font-mono text-xs shrink-0">{cmd}</code>
                      <span className="text-subtext text-[10px]">— {desc}</span>
                    </div>
                  ))}
                </div>
              </div>
              {/* 路径二 */}
              <div className="px-4 py-3">
                <p className="text-xs font-semibold text-sapphire mb-2">大功能 / 需求不清晰 → 从规划开始</p>
                <div className="flex flex-col gap-1.5">
                  {[
                    ["产品规划", "/bmad-bmm-create-prd",                   "在现有 PRD 中追加新需求"],
                    ["架构设计", "/bmad-bmm-create-architecture",           "（可选）影响架构时更新技术方案"],
                    ["史诗规划", "/bmad-create-epics-and-stories",          "为新功能分解 Epics / Stories"],
                    ["史诗规划", "/bmad-check-implementation-readiness",    "验证开发就绪度"],
                    ["编码实现", "/bmad-sprint-planning",                   "生成新 Sprint 计划"],
                    ["编码实现", "/bmad-create-story",                      "逐条创建 Story 文件"],
                    ["编码实现", "/bmad-bmm-dev-story",                     "实现"],
                    ["编码实现", "/bmad-code-review",                       "审查"],
                    ["质量审查", "/bmad-bmm-qa-generate-e2e-tests",         "补充测试"],
                  ].map(([stage, cmd, desc]) => (
                    <div key={cmd} className="flex items-center gap-2">
                      <span className="text-overlay0 text-[10px] w-14 shrink-0">{stage}</span>
                      <code className="text-mauve font-mono text-xs shrink-0">{cmd}</code>
                      <span className="text-subtext text-[10px]">— {desc}</span>
                    </div>
                  ))}
                </div>
              </div>
              {/* 附注 */}
              <div className="px-4 py-2.5 bg-surface0/20">
                <p className="text-overlay0 text-[10px] leading-relaxed">
                  💡 在侧边栏点击对应阶段的「重新进入」即可跳回。已有 PRD、架构文档会被自动发现并复用，无需从零开始。<br/>
                  方向变化时用 <code className="text-mauve">/bmad-correct-course</code>，功能上线后用 <code className="text-mauve">/bmad-retrospective</code> 复盘。
                </p>
              </div>
            </div>
          </section>

          {/* 使用技巧 */}
          <section className="rounded-xl border border-surface0/60 overflow-hidden">
            <div className="flex items-center gap-2.5 px-4 py-2.5 bg-surface0/30 border-b border-surface0/40">
              <span className="text-base">⚡</span>
              <span className="text-sm font-semibold text-text">使用技巧</span>
            </div>
            <ul className="divide-y divide-surface0/40">
              {[
                ["侧边栏阶段切换", "点击各阶段的「开始」可随时跳转，已完成阶段显示「重新进入」"],
                ["推进流程",       "侧边栏底部「推进下一阶段」按钮，快速进入下一流程"],
                ["PM 快捷操作",    "PM 阶段侧边栏内置「生成线框图」和「保存线框图」快捷按钮"],
                ["复制粘贴",       "Cmd+C 复制终端选中内容（无选中时发送中断信号），Cmd+V 粘贴"],
                ["历史会话",       "顶栏「加载历史」按钮调出 /resume 会话列表，可恢复历史对话"],
                ["修复命令",       "顶栏「修复命令」按钮重新生成 .claude/commands/ 文件（遇到 Unknown skill 时使用）"],
              ].map(([title, tip]) => (
                <li key={title} className="flex items-start gap-3 px-4 py-2.5 hover:bg-surface0/30 transition-colors">
                  <span className="text-sapphire text-xs font-semibold shrink-0 mt-0.5 w-20">{title}</span>
                  <span className="text-subtext text-xs leading-relaxed">{tip}</span>
                </li>
              ))}
            </ul>
          </section>

        </div>
      </div>
    </div>
  )
}

// ============================================================
// 退出确认模态框
// ============================================================

interface ExitConfirmModalProps {
  onSaveExit: () => void
  onExit:     () => void
  onCancel:   () => void
}

function ExitConfirmModal({ onSaveExit, onExit, onCancel }: ExitConfirmModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-base/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-sm bg-mantle rounded-2xl border border-surface0 shadow-2xl overflow-hidden">

        <div className="p-6 text-center">
          {/* 警告图标 */}
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-surface0 mb-4">
            <svg className="h-7 w-7 text-yellow" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round"
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
          </div>
          <h3 className="text-xl font-bold text-text mb-2">退出确认</h3>
          <p className="text-subtext text-sm">是否保存当前会话？未保存的内容将会丢失。</p>
        </div>

        <div className="p-5 bg-crust/50 border-t border-surface0 flex flex-col gap-3">
          <button
            onClick={onSaveExit}
            className="w-full px-4 py-2.5 rounded-xl bg-mauve text-crust font-semibold
                       hover:opacity-90 active:scale-[0.98] transition-all"
          >
            保存并退出
          </button>
          <button
            onClick={onExit}
            className="w-full px-4 py-2.5 rounded-xl bg-red text-crust font-semibold
                       hover:opacity-90 active:scale-[0.98] transition-all"
          >
            直接退出
          </button>
          <button
            onClick={onCancel}
            className="w-full px-4 py-2.5 rounded-xl bg-surface0 text-text font-medium
                       hover:bg-surface1 active:scale-[0.98] transition-all"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  )
}

// ============================================================
// 文件浏览器
// ============================================================

interface FsEntry { name: string; path: string; isDir: boolean }

interface FileNodeState {
  entry:    FsEntry
  children: FileNodeState[] | null  // null = 未加载，[] = 已加载但为空
  expanded: boolean
}

function buildRoots(entries: FsEntry[]): FileNodeState[] {
  return entries.map(e => ({ entry: e, children: null, expanded: false }))
}

// 递归更新树中指定路径节点的状态
function updateNode(
  nodes: FileNodeState[],
  targetPath: string,
  updater: (n: FileNodeState) => FileNodeState,
): FileNodeState[] {
  return nodes.map(n => {
    if (n.entry.path === targetPath) return updater(n)
    if (n.children) return { ...n, children: updateNode(n.children, targetPath, updater) }
    return n
  })
}

interface FileBrowserProps {
  isOpen:      boolean
  onClose:     () => void
  rootPath:    string
}

function FileBrowser({ isOpen, onClose, rootPath }: FileBrowserProps) {
  const [nodes, setNodes] = useState<FileNodeState[]>([])

  // 根目录加载
  useEffect(() => {
    if (!isOpen || !rootPath) return
    window.bmad.fs.listDir(rootPath).then(entries => setNodes(buildRoots(entries))).catch(() => {})
  }, [isOpen, rootPath])

  // 点击文件夹：懒加载子项并切换展开状态
  async function toggleDir(node: FileNodeState) {
    const p = node.entry.path
    if (!node.expanded && node.children === null) {
      // 首次展开：请求子内容
      const children = await window.bmad.fs.listDir(p).catch(() => [] as FsEntry[])
      setNodes(prev => updateNode(prev, p, n => ({
        ...n, expanded: true, children: buildRoots(children),
      })))
    } else {
      setNodes(prev => updateNode(prev, p, n => ({ ...n, expanded: !n.expanded })))
    }
  }

  // 点击文件：复制路径到剪贴板
  function copyPath(p: string) {
    navigator.clipboard.writeText(p).catch(() => {})
  }

  return (
    <div
      className={[
        "flex flex-col bg-mantle border-l border-surface0 shrink-0 transition-all duration-300 ease-in-out",
        isOpen ? "w-[220px]" : "w-0 border-transparent",
      ].join(" ")}
    >
      {/* 固定宽度内容容器，防止收起动画时文字换行 */}
      <div className="w-[220px] h-full flex flex-col overflow-hidden">
        <div className="h-9 bg-crust border-b border-surface0 flex items-center px-3 shrink-0 gap-2">
          <span className="text-xs font-semibold text-subtext uppercase tracking-wider flex-1">文件</span>
          <button
            onClick={onClose}
            className="text-overlay0 hover:text-red transition-colors p-1 rounded hover:bg-surface0"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto overflow-x-hidden py-1">
          {nodes.map(n => (
            <FileTreeNode key={n.entry.path} node={n} depth={0} onToggleDir={toggleDir} onClickFile={copyPath} />
          ))}
        </div>
      </div>
    </div>
  )
}

function FileTreeNode({ node, depth, onToggleDir, onClickFile }: {
  node:         FileNodeState
  depth:        number
  onToggleDir:  (n: FileNodeState) => void
  onClickFile:  (path: string) => void
}) {
  const { entry, expanded, children } = node
  const icon = entry.isDir
    ? (expanded ? "📂" : "📁")
    : getFileIcon(entry.name)

  return (
    <div>
      <div
        className="flex items-center gap-1 py-[2px] hover:bg-surface0 cursor-pointer select-none transition-colors"
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        title={entry.path}
        onClick={() => entry.isDir ? onToggleDir(node) : onClickFile(entry.path)}
      >
        <span className="w-4 flex-shrink-0 text-center text-[11px] leading-none">{icon}</span>
        <span className="text-xs text-text truncate">{entry.name}</span>
      </div>
      {entry.isDir && expanded && children && children.map(c => (
        <FileTreeNode key={c.entry.path} node={c} depth={depth + 1} onToggleDir={onToggleDir} onClickFile={onClickFile} />
      ))}
    </div>
  )
}

function getFileIcon(name: string): string {
  if (name.endsWith(".ts") || name.endsWith(".tsx")) return "🔷"
  if (name.endsWith(".md"))   return "📝"
  if (name.endsWith(".json")) return "🔧"
  if (name.endsWith(".css"))  return "🎨"
  if (name.endsWith(".html")) return "🌐"
  if (name.endsWith(".yml") || name.endsWith(".yaml")) return "⚙️"
  return "📄"
}

// ============================================================
// Window 类型扩展
// ============================================================

declare global {
  interface Window {
    bmad: {
      ping: (req: import("@bmad-claude/ipc-contracts").PingRequest) => Promise<import("@bmad-claude/ipc-contracts").PingResponse>
      deps: {
        check:         () => Promise<import("@bmad-claude/ipc-contracts").DepCheckResult>
        installClaude:    () => Promise<{ ok: boolean; error?: string }>
        installCodex:     () => Promise<{ ok: boolean; error?: string }>
        installGemini:    () => Promise<{ ok: boolean; error?: string }>
        installAllInOne:    () => Promise<{ ok: boolean; error?: string }>
        installSuperpowers: (req: { projectPath: string }) => Promise<{ ok: boolean; error?: string }>
      }
      storage: {
        listProjects:  () => Promise<import("@bmad-claude/ipc-contracts").StorageProjectItem[]>
        deleteProject: (projectPath: string) => Promise<void>
        saveProject:   (req: import("@bmad-claude/ipc-contracts").StorageUpsertProjectRequest) => Promise<void>
      }
      dialog: {
        openDir: () => Promise<string | null>
      }
      fs: {
        listDir: (dirPath: string) => Promise<import("@bmad-claude/ipc-contracts").FsEntry[]>
      }
      installer: {
        install:        (req: import("@bmad-claude/ipc-contracts").BmadInstallRequest) => Promise<import("@bmad-claude/ipc-contracts").BmadInstallResponse>
        repairCommands: (req: import("@bmad-claude/ipc-contracts").BmadInstallRequest) => Promise<import("@bmad-claude/ipc-contracts").BmadInstallResponse>
      }
      pty: {
        spawn:  (req: import("@bmad-claude/ipc-contracts").PtySpawnRequest)  => Promise<void>
        write:  (req: import("@bmad-claude/ipc-contracts").PtyWriteRequest)  => Promise<void>
        resize: (req: import("@bmad-claude/ipc-contracts").PtyResizeRequest) => Promise<void>
        kill:   (req: import("@bmad-claude/ipc-contracts").PtyKillRequest)   => Promise<void>
        onData: (fn: (ev: import("@bmad-claude/ipc-contracts").PtyDataEvent) => void) => () => void
        onExit: (fn: (ev: import("@bmad-claude/ipc-contracts").PtyExitEvent) => void) => () => void
      }
      workflow: {
        start:      (req: import("@bmad-claude/ipc-contracts").WorkflowStartRequest) => Promise<import("@bmad-claude/ipc-contracts").WorkflowSnapshot>
        sendEvent:  (req: import("@bmad-claude/ipc-contracts").WorkflowEventRequest) => Promise<import("@bmad-claude/ipc-contracts").WorkflowSnapshot | null>
        onSnapshot: (fn: (s: import("@bmad-claude/ipc-contracts").WorkflowSnapshot) => void) => () => void
      }
    }
  }
}
