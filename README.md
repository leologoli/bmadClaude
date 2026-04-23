# BMAD Claude

AI 驱动的敏捷开发桌面工具。将 BMAD 方法论与多 AI 模型协作融入一体，通过结构化工作流引导产品从需求到交付的全流程。

## 功能特性

- **结构化工作流**：intake → brainstorm → analyst → pm → ux-designer → architect → developer → qa → done，每个阶段对应独立 AI 角色
- **集成终端**：内嵌 xterm.js 终端，直接与 Claude / Codex / Gemini CLI 交互
- **多模型协作**：支持 Claude Code、OpenAI Codex、Google Gemini CLI 联动
- **Superpowers 技能**：一键为项目安装 obra/superpowers 技能集
- **线框图生成**：PM 阶段快捷生成与保存线框图
- **本地持久化**：项目配置与工作流状态本地存储，随时恢复进度

## 技术栈

| 层次 | 技术 |
|------|------|
| 桌面框架 | Electron 33+ |
| 前端 | React 18 + TypeScript 5.7+ |
| 构建 | electron-vite + Vite 5 |
| 包管理 | pnpm 9.12+（monorepo） |
| 状态机 | XState 5.28+ |
| 样式 | Tailwind CSS 4.0（Catppuccin 主题） |
| 终端 | xterm.js + node-pty |

## 项目结构

```
bmad-claude/
├── apps/
│   └── desktop/          # Electron 主应用
│       ├── electron/     # 主进程（main.ts、preload.ts）
│       └── src/          # 渲染进程（React）
└── packages/
    ├── workflow-engine/  # XState 工作流状态机
    ├── ipc-contracts/    # IPC 类型定义与常量
    ├── pty-bridge/       # PTY 终端会话管理
    ├── bmad-registry/    # BMAD 方法注册表（YAML 解析）
    └── storage/          # 本地存储管理
```

## 快速开始

### 环境要求

- Node.js 20+
- pnpm 9.12+

### 安装与运行

```bash
# 安装依赖
pnpm install

# 开发模式（热更新）
pnpm dev
```

### 打包发布

```bash
cd apps/desktop

pnpm package:mac    # macOS（arm64 + x64）
pnpm package:win    # Windows
pnpm package:linux  # Linux（AppImage + deb）
```

## 开发命令

```bash
pnpm build       # 构建所有包
pnpm typecheck   # 全量类型检查
pnpm lint        # 全量 lint
```

## 工作流说明

每次启动项目时，应用将按顺序激活以下 BMAD 角色：

1. **intake** — 需求收集
2. **brainstorm** — 头脑风暴
3. **analyst** — 需求分析
4. **pm** — 产品规划（含线框图生成）
5. **ux-designer** — UX 设计
6. **architect** — 系统架构
7. **developer** — 编码实现
8. **qa** — 质量保障
9. **done** — 交付完成

已完成的阶段可随时点击「重新进入」回溯。

## License

MIT
