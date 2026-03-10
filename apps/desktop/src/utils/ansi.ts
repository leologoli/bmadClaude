// ============================================================
// ANSI 转义码剥离工具
// 基于 strip-ansi@7 的标准 regex，覆盖：
//   - CSI 序列（颜色、光标移动、清屏等）
//   - OSC 序列（标题设置、超链接等）
//   - DCS / PM / APC 序列
//   - C1 控制字符
//   - 不可打印控制字符（保留 \t \n）
// ============================================================

// OSC：ESC ] ... BEL/ST
const OSC_RE = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g

// DCS / PM / APC：ESC P/^ / _ ... ST
const DCS_RE = /\u001B[P^_][^\u001B]*(?:\u001B\\|\u009C)/g

// 标准 strip-ansi@7 模式（最全面的 CSI 匹配）
const CSI_RE = new RegExp(
  "[\\u001B\\u009B][[\\]()#;?]*(?:" +
  "(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?(?:\\u0007|\\u001B\\u005C|\\u009C))" +
  "|" +
  "(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))",
  "g",
)

// 不可打印控制字符（排除 \t=\x09 和 \n=\x0a）
const CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/g

// Claude Code UI 装饰字符（非内容）：
// - 块状元素（TUI 动画方块）：U+2580-U+259F（▀▄▌▐▗▖▘▝ 等）
// - Black Small Square（进度指示 ▪）：U+25AA
// - Dingbats（thinking spinner ✳✢✶✻✽）：U+2700-U+27BF
// - 盲文点阵（spinner 动画）：U+2800-U+28FF
const UI_CHROME_RE = /[\u2580-\u259F\u25AA\u2700-\u27BF\u2800-\u28FF]/g

export function stripAnsi(raw: string): string {
  return raw
    .replace(OSC_RE, "")
    .replace(DCS_RE, "")
    .replace(CSI_RE, "")
    .replace(CTRL_RE, "")
    .replace(UI_CHROME_RE, "")
}

// ============================================================
// cleanChatContent：移除 Claude Code UI chrome 和 thinking 动画噪声
// ============================================================

// 纯框线行（Claude Code welcome banner 框线）
const BOX_ONLY_LINE_RE = /^[\s╭╮╰╯─│╴╵╶╷┌┐└┘├┤┬┴┼═║╔╗╚╝\-=*#~]+$/

// Claude Code thinking 文本标记（(thinking)、(thought for 9s) 等）
const THINKING_TEXT_RE = /\s*\(thinking\)\s*|\s*\(thought\s+for\s+[\d.]+\s*s\s*\)\s*/g

// thinking 动画状态词：以大写字母开头 + 省略号结尾，20 字符以内（如 "Catapulting…"）
const THINKING_STATUS_RE = /^[A-Z][a-zA-Z\s]{1,15}[…]{1}$/

export function cleanChatContent(text: string): string {
  // 1. 移除 thinking 文本标记
  const withoutThinking = text.replace(THINKING_TEXT_RE, "\n")

  const lines = withoutThinking.split("\n")
  const cleaned = lines
    .filter((line) => {
      const t = line.trim()
      if (!t) return true   // 空行留着，后面再收缩

      // 纯框线行
      if (BOX_ONLY_LINE_RE.test(line)) return false

      // thinking 动画状态词（"Catapulting…" 等）
      if (THINKING_STATUS_RE.test(t)) return false

      // 极短行（≤3 个可见字符）：动画碎片（单字母行、"tg"、"ln" 等）
      // 排除中文、数字行（数字单行有时是合法编号）
      if (t.length <= 3 && !/[\u4e00-\u9fff\d]/.test(t)) return false

      // thinking 残片：纯小写英文 + 可选括号，≤8 字符，不含空格
      // 匹配 "inking)"、"hinking"、"tg"、"ng"…
      if (/^[a-z()]+$/.test(t) && t.length <= 8) return false

      return true
    })
    // 收起连续超过 2 个的空行
    .reduce<string[]>((acc, line) => {
      const isBlank = line.trim() === ""
      const lastTwo = acc.slice(-2).every((l) => l.trim() === "")
      if (isBlank && lastTwo) return acc
      return [...acc, line]
    }, [])

  return cleaned.join("\n").trim()
}

// ============================================================
// isPureThinkingAnimation：判断内容是否全是 thinking 动画（无实质响应）
// 用于在流式输出阶段跳过 thinking 帧，避免在 chat 中显示动画噪声
// ============================================================

export function isPureThinkingAnimation(display: string): boolean {
  // 去掉 thinking 标记和标点后的剩余文本
  const residual = display
    .replace(THINKING_TEXT_RE, "")
    .replace(/[·…\-_=\s\n]+/g, " ")
    .trim()

  // 如果含有 thinking 标记 且剩余实质文本很少（<15 字符），判定为纯动画
  const hasThinkingMarker = /\(thinking\)|\(thought\s+for/i.test(display)
  return hasThinkingMarker && residual.length < 15
}
