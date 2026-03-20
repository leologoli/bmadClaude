# BMAD Claude 使用指南

## 一、界面概览

```
┌─────────────────────────────────────────────────────┐
│  工作流阶段栏（顶部）                                  │
│  intake → brainstorm → analyst → pm → ux → arch → dev → qa │
├───────────────┬─────────────────────────────────────┤
│               │                                     │
│  项目列表     │   内置终端（xterm.js）               │
│  （左侧）     │   Claude Code 运行在此               │
│               │                                     │
└───────────────┴─────────────────────────────────────┘
```

---

## 二、启动模式

### 模式一：BMAD 项目（完整 AI 敏捷工作流）

适用于需要从 0 到 1 完整规划和开发的项目。

**步骤：**

1. 点击「新建项目」
2. 填写项目名称和项目目录路径（可点击文件夹图标选择）
3. 选择需要安装的可选工具
4. 点击「开始」，应用自动完成依赖检查和 BMAD 工作流文件安装
5. 终端自动启动 Claude Code，进入 `brainstorm`（头脑风暴）阶段

### 模式二：普通任务

适用于临时编码任务，无需完整工作流。

**步骤：**

1. 点击「普通任务」
2. 选择工作目录
3. 终端直接启动 Claude Code，无工作流约束

---

## 三、BMAD 工作流阶段

工作流按固定顺序推进，每个阶段对应一个 Claude Code 斜杠命令：

| 阶段 | 斜杠命令 | 产出物 |
|------|----------|--------|
| **brainstorm** 头脑风暴 | `/bmad-brainstorming` | 创意发散、方向确认 |
| **analyst** 需求分析 | `/bmad-bmm-create-product-brief` | Product Brief 产品概要 |
| **pm** 产品规划 | `/bmad-bmm-create-prd` | PRD 产品需求文档 |
| **ux-designer** UX 设计 | `/bmad-bmm-create-ux-design` | UX 设计规范 |
| **architect** 架构设计 | `/bmad-bmm-create-architecture` | 技术架构文档 |
| **developer** 开发实现 | `/bmad-bmm-dev-story` | Story 实现 |
| **qa** 质量保障 | `/bmad-bmm-qa-generate-e2e-tests` | E2E 测试 |
| **done** 完成 | — | 全流程结束 |

### 切换阶段

- **手动推进**：点击顶部阶段栏中的目标阶段，或点击「下一阶段」按钮
- **自动推进**：Claude Code 完成当前阶段任务后，工作流引擎会根据置信度自动推进
- **跳转任意阶段**：点击阶段栏任意节点可直接跳转（不会丢失上下文）

> 每次切换阶段时，应用会自动向终端发送对应的斜杠命令，Claude Code 会加载该阶段的工作流文件并开始执行。

---

## 四、内置终端使用

终端运行完整的 Claude Code，支持所有 Claude Code 原生功能。

### 常用操作

| 操作 | 说明 |
|------|------|
| 直接输入 | 与 Claude Code 对话 |
| `/` + 命令名 | 执行 BMAD 斜杠命令 |
| `Ctrl+C` | 中断当前操作 |
| `claude --resume` | 恢复上次会话 |

### BMAD 产出文件

工作流产出的所有文档存放在项目目录的 `_bmad-output/` 下：

```
<项目目录>/
├── _bmad/                    BMAD 工作流引擎文件（勿手动修改）
│   ├── bmm/                  业务流程工作流
│   └── core/                 核心任务和工具
├── _bmad-output/             ← 产出文档在这里
│   ├── planning-artifacts/   PRD、Brief 等规划文档
│   └── implementation-artifacts/  架构、Story 等实现文档
└── .claude/commands/         Claude Code 斜杠命令定义
```

---

## 五、历史项目管理

### 恢复历史项目

启动后主界面列出所有历史项目，点击任意项目可继续上次工作。应用会：
1. 恢复上次的工作流阶段
2. 重新启动 PTY 终端
3. 自动发送 `claude --resume` 恢复 Claude Code 上下文

### 删除项目记录

在项目列表中，点击项目右侧的删除图标可移除历史记录。

> **注意**：删除记录不会删除磁盘上的项目文件，仅清除 BMAD Claude 内的会话历史。

---

## 六、All-in-One 多模型协作

安装 All-in-One 后，Claude Code 内部会自动启用 Codex 和 Gemini 两个 MCP 服务，Claude 在工作时会：

- 将需求分析和实施计划同步给 Codex/Gemini 进行交叉验证
- 前端任务优先请求 Gemini 提供 UI 原型代码
- 后端/逻辑任务优先请求 Codex 提供代码原型
- 每次编码完成后自动用 Codex review 改动

这套协作机制写在 `~/.claude/CLAUDE.md` 的 `## Core Instruction` 段落中，Claude Code 每次启动时自动读取。

### 重新安装 All-in-One

若配置丢失（如 cc-switch 覆盖了 `~/.claude.json`），只需在任意项目启动界面勾选「安装 All-in-One」并点击开始，应用会幂等地修复配置，不会重复安装已有组件。

---

## 七、常见操作问答

**Q：工作流卡在某个阶段，想重新开始该阶段怎么办？**

直接点击阶段栏当前阶段节点，应用会重新发送该阶段的斜杠命令。

**Q：终端意外关闭或卡死怎么办？**

刷新应用窗口（macOS：`Cmd+R`，Windows：`Ctrl+R`），或关闭后重新从历史项目列表进入，会自动重建终端会话。

**Q：BMAD 工作流文件需要手动更新吗？**

新建项目时会自动从 GitHub 下载最新版本（有本地缓存则直接使用缓存）。若需强制更新，删除 `~/.bmad-claude/bmad-cache/` 目录后重新安装项目即可。

**Q：多个项目可以同时开着吗？**

当前版本每个应用窗口只支持一个活动项目。如需并行，可打开多个应用实例（macOS 不直接支持，建议使用终端多开）。

**Q：Windows 上 All-in-One 安装了很久没有反应？**

通常是首次下载 MCP Python 包耗时较长。查看应用日志（DevTools Console）可确认进度。若超过 10 分钟仍无响应，尝试关闭后重新安装——venv 完整后会自动跳过安装步骤。
