import { assign, createActor, setup } from "xstate"
import type {
  ArtifactRef,
  BmadRole,
  TransitionLogEntry,
  WorkflowEventType,
  WorkflowSnapshot,
} from "@bmad-claude/ipc-contracts"

// ============================================================
// 工作流上下文（通过 input 注入初始值）
// ============================================================

interface WorkflowInput {
  workflowId: string
  projectName: string
  projectPath: string
  initialRole: BmadRole
}

interface WorkflowContext {
  workflowId: string
  projectName: string
  projectPath: string
  currentRole: BmadRole
  previousRole: BmadRole | undefined
  isManualLock: boolean
  failureReason: string | undefined
  artifacts: ArtifactRef[]
  transitionLog: TransitionLogEntry[]
}

// ============================================================
// BMAD 角色流程顺序
// ============================================================

const ROLE_SEQUENCE: BmadRole[] = [
  "intake", "brainstorm", "analyst", "pm", "ux-designer", "architect", "developer", "qa", "done",
]

// ============================================================
// XState v5 状态机
// ============================================================

const bmadMachine = setup({
  types: {
    context: {} as WorkflowContext,
    events:  {} as WorkflowEventType,
    input:   {} as WorkflowInput,
  },
  actions: {
    // 计算目标角色并记录切换日志
    logTransition: assign(({ context, event }) => {
      const target = resolveTargetRole(context.currentRole, event)
      if (!target) return {}
      const entry: TransitionLogEntry = {
        from: context.currentRole,
        to: target,
        reason: getTransitionReason(event),
        timestamp: Date.now(),
        automatic: event.type === "AUTO_ADVANCE",
      }
      return {
        previousRole: context.currentRole,
        currentRole: target,
        transitionLog: [...context.transitionLog, entry],
      }
    }),
    // 手动切换时锁定自动推进
    lockManual: assign({ isManualLock: () => true }),
    // 解锁（RETRY 时解除手动锁）
    unlock: assign({ isManualLock: () => false }),
    clearFailure: assign({ failureReason: () => undefined }),
    // 进入 failed XState 状态时同步更新 currentRole
    recordFailure: assign({
      currentRole: () => "failed" as BmadRole,
      failureReason: ({ event }) =>
        event.type === "FAIL" ? event.reason : undefined,
    }),
  },
  guards: {
    // 自动推进被手动锁定时阻止
    isNotManualLocked: ({ context }) => !context.isManualLock,
    // 自动推进需置信度 > 0.7
    hasHighConfidence: ({ event }) =>
      event.type === "AUTO_ADVANCE" && event.confidence > 0.7,
  },
}).createMachine({
  id: "bmadWorkflow",
  // XState v5：通过 input 工厂函数注入初始 context
  context: ({ input }: { input: WorkflowInput }) => ({
    workflowId:    input.workflowId,
    projectName:   input.projectName,
    projectPath:   input.projectPath,
    currentRole:   input.initialRole,
    previousRole:  undefined,
    isManualLock:  false,
    failureReason: undefined,
    artifacts:     [],
    transitionLog: [],
  }),
  initial: "active",
  states: {
    active: {
      on: {
        NEXT:    { actions: ["clearFailure", "logTransition"] },
        APPROVE: { actions: ["clearFailure", "logTransition"] },

        // 手动切换：锁定自动推进
        SWITCH_ROLE: { actions: ["lockManual", "logTransition"] },

        // 自动推进：仅在未手动锁定且置信度足够时执行
        AUTO_ADVANCE: {
          guard: ({ context, event }) =>
            !context.isManualLock &&
            event.type === "AUTO_ADVANCE" &&
            event.confidence > 0.7,
          actions: ["logTransition"],
        },

        FAIL: { target: "failed", actions: ["recordFailure"] },
      },
    },
    failed: {
      on: {
        RETRY: {
          target: "active",
          actions: ["clearFailure", "unlock"],
        },
        // 失败状态下也允许手动切换角色恢复
        SWITCH_ROLE: {
          target: "active",
          actions: ["lockManual", "logTransition", "clearFailure"],
        },
      },
    },
  },
})

// ============================================================
// 工作流管理器：维护多个项目的独立工作流实例
// ============================================================

export class WorkflowManager {
  private readonly actors = new Map<
    string,
    ReturnType<typeof createActor<typeof bmadMachine>>
  >()

  start(
    workflowId: string,
    projectName: string,
    projectPath: string,
    initialRole: BmadRole = "intake",
  ): WorkflowSnapshot {
    // 销毁已有实例
    this.actors.get(workflowId)?.stop()

    // XState v5：通过 input 选项注入初始 context
    const actor = createActor(bmadMachine, {
      input: { workflowId, projectName, projectPath, initialRole },
    })
    actor.start()
    this.actors.set(workflowId, actor)

    return toSnapshot(actor.getSnapshot().context)
  }

  sendEvent(workflowId: string, event: WorkflowEventType): WorkflowSnapshot | null {
    const actor = this.actors.get(workflowId)
    if (!actor) return null
    actor.send(event)
    // XState v5 同步 assign 后 getSnapshot().context 即为最新值
    return toSnapshot(actor.getSnapshot().context)
  }

  stopAll(): void {
    for (const actor of this.actors.values()) actor.stop()
    this.actors.clear()
  }
}

// ============================================================
// 工具函数
// ============================================================

function toSnapshot(ctx: WorkflowContext): WorkflowSnapshot {
  return {
    workflowId:    ctx.workflowId,
    currentRole:   ctx.currentRole,
    previousRole:  ctx.previousRole,
    isManualLock:  ctx.isManualLock,
    failureReason: ctx.failureReason,
    artifacts:     ctx.artifacts,
    transitionLog: ctx.transitionLog,
  }
}

function resolveTargetRole(current: BmadRole, event: WorkflowEventType): BmadRole | undefined {
  if (event.type === "SWITCH_ROLE")   return event.target
  if (event.type === "AUTO_ADVANCE")  return event.target
  if (event.type === "NEXT" || event.type === "APPROVE") {
    const idx = ROLE_SEQUENCE.indexOf(current)
    return idx >= 0 && idx < ROLE_SEQUENCE.length - 1
      ? ROLE_SEQUENCE[idx + 1]
      : undefined
  }
  return undefined
}

function getTransitionReason(event: WorkflowEventType): string {
  switch (event.type) {
    case "NEXT":         return "用户确认推进"
    case "APPROVE":      return "人工审批通过"
    case "SWITCH_ROLE":  return `手动切换至 ${event.target}`
    case "AUTO_ADVANCE": return `自动推进（置信度 ${(event.confidence * 100).toFixed(0)}%）`
    default:             return event.type
  }
}
