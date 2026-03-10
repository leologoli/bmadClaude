import { useCallback, useEffect, useRef, useState } from "react"
import { stripAnsi, cleanChatContent, isPureThinkingAnimation } from "../utils/ansi"

// ============================================================
// 类型定义
// ============================================================

export type MessageRole = "user" | "assistant" | "system"

export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  streaming: boolean     // 是否仍在流式输出中
  createdAt: number
}

interface UseChatPtyOptions {
  sessionId: string
  enabled: boolean       // PTY 启动后设为 true
  idleMs?: number        // 无数据多少毫秒后判定响应结束（默认 400）
}

interface UseChatPtyResult {
  messages: ChatMessage[]
  isProcessing: boolean
  sendMessage: (text: string) => Promise<void>
}

// ============================================================
// 常量
// ============================================================

// 匹配 Claude Code 提示符行：行末为 "> " 或 "❯ "（可能有前导空格）
const PROMPT_LINE_RE = /(?:^|\n)\s*[>❯]\s*(?:\n|$)/

// ============================================================
// 工具函数
// ============================================================

// 从原始 PTY 数据（全量）得到干净的显示文本
// 全量 strip 而非逐 chunk strip，避免 ANSI 转义序列被 chunk 边界切断导致残留（如 ;215m）
function processRaw(raw: string): string {
  return stripAnsi(raw)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
}

// ============================================================
// Hook
// ============================================================

export function useChatPty({
  sessionId,
  enabled,
  idleMs = 400,
}: UseChatPtyOptions): UseChatPtyResult {
  const [messages, setMessages]         = useState<ChatMessage[]>([])
  const [isProcessing, setIsProcessing] = useState(false)

  // 原始 PTY 数据缓冲（不做逐 chunk strip，保存完整原始流以供全量处理）
  const rawBufRef    = useRef("")
  // 当前正在流式输出的 assistant 消息 ID（null 表示无活跃消息）
  const activeIdRef  = useRef<string | null>(null)
  // 空闲超时 timer
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 发送消息后需要跳过 PTY 对用户输入的 echo 回显
  const skipEchoRef  = useRef<string | null>(null)

  // ── 清除空闲 timer ──
  const clearIdleTimer = useCallback(() => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current)
      idleTimerRef.current = null
    }
  }, [])

  // ── 结束当前 assistant 消息 ──
  const finishAssistant = useCallback(() => {
    clearIdleTimer()
    const msgId = activeIdRef.current
    if (!msgId) {
      setIsProcessing(false)
      return
    }

    // 对全量原始数据做最终清理（去提示符 + cleanChatContent 去框线/多余空行）
    const finalContent = cleanChatContent(
      processRaw(rawBufRef.current).replace(PROMPT_LINE_RE, ""),
    )

    setMessages((prev) => {
      // 内容为空则移除该消息（例如只有提示符）
      if (!finalContent) return prev.filter((m) => m.id !== msgId)
      return prev.map((m) =>
        m.id === msgId ? { ...m, content: finalContent, streaming: false } : m,
      )
    })

    rawBufRef.current   = ""   // 重置原始缓冲，为下一条消息做准备
    activeIdRef.current = null
    setIsProcessing(false)
  }, [clearIdleTimer])

  // ── 安排空闲结束 ──
  const scheduleIdle = useCallback(() => {
    clearIdleTimer()
    idleTimerRef.current = setTimeout(finishAssistant, idleMs)
  }, [clearIdleTimer, finishAssistant, idleMs])

  // ── sessionId 变化时重置全部状态 ──
  useEffect(() => {
    setMessages([])
    setIsProcessing(false)
    rawBufRef.current   = ""
    activeIdRef.current = null
    skipEchoRef.current = null
    clearIdleTimer()
  }, [sessionId, clearIdleTimer])

  // ── 订阅 PTY 数据流 ──
  useEffect(() => {
    if (!enabled) return

    const offData = window.bmad.pty.onData((ev) => {
      if (ev.sessionId !== sessionId) return

      const raw = ev.data

      // 过滤用户输入的 PTY echo 回显：
      // 发送消息后 PTY 会把用户输入原样回显，对当前 chunk 做检测并跳过
      // （逐 chunk 检测 echo，不加入 rawBuf，从而不污染全量缓冲）
      if (skipEchoRef.current) {
        const chunkDisplay = processRaw(raw)
        const echo = skipEchoRef.current
        if (chunkDisplay.includes(echo) || echo.includes(chunkDisplay.trim())) {
          skipEchoRef.current = null
          return   // 跳过 echo chunk，不追加到 rawBuf
        }
        skipEchoRef.current = null
      }

      // 追加原始数据到缓冲，全量 strip 得到干净的显示内容
      rawBufRef.current += raw
      const display = processRaw(rawBufRef.current)

      // 忽略纯提示符 chunk（仅含 "> " 的空响应）
      const withoutPrompt = display.replace(PROMPT_LINE_RE, "").trim()
      if (!withoutPrompt) return

      // 忽略纯 thinking 动画帧（仅显示"思考中"指示器，不创建 chat 消息）
      // thinking 动画结束后，Claude 的真实响应会作为新数据继续到来
      if (isPureThinkingAnimation(withoutPrompt)) {
        setIsProcessing(true)
        scheduleIdle()
        return
      }

      // 追加到 assistant 消息
      const msgId = activeIdRef.current ?? crypto.randomUUID()
      if (!activeIdRef.current) activeIdRef.current = msgId

      setMessages((prev) => {
        const exists = prev.find((m) => m.id === msgId)
        if (exists) {
          return prev.map((m) =>
            m.id === msgId ? { ...m, content: display, streaming: true } : m,
          )
        }
        return [...prev, {
          id: msgId, role: "assistant",
          content: display, streaming: true,
          createdAt: Date.now(),
        }]
      })
      setIsProcessing(true)

      // 若已出现提示符则立即结束；否则刷新空闲计时
      if (PROMPT_LINE_RE.test(display)) {
        finishAssistant()
      } else {
        scheduleIdle()
      }
    })

    return () => {
      offData()
      clearIdleTimer()
    }
  }, [enabled, sessionId, clearIdleTimer, finishAssistant, scheduleIdle])

  // ── 发送用户消息 ──
  const sendMessage = useCallback(async (text: string) => {
    const content = text.trim()
    if (!enabled || !content) return

    // 如有未完成的 assistant 消息，先关闭它
    finishAssistant()

    // 记录将要 echo 的内容，供后续过滤
    skipEchoRef.current = content

    setMessages((prev) => [...prev, {
      id: crypto.randomUUID(), role: "user",
      content, streaming: false, createdAt: Date.now(),
    }])
    setIsProcessing(true)

    await window.bmad.pty.write({ sessionId, data: `${content}\r` })
  }, [enabled, sessionId, finishAssistant])

  return { messages, isProcessing, sendMessage }
}
