import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, externalizeDepsPlugin } from "electron-vite"

// workspace 包名列表：排除在外部化之外，由 vite 直接打包进输出文件
// （避免 ESM workspace 包在 Electron CJS 环境下 import 报错）
const WORKSPACE_PKGS = [
  "@bmad-claude/ipc-contracts",
  "@bmad-claude/pty-bridge",
  "@bmad-claude/workflow-engine",
  "@bmad-claude/bmad-registry",
  "@bmad-claude/storage",
]

// alias：将 workspace 包映射到 TypeScript 源文件，由 vite 编译打包
const workspaceAlias = {
  "@bmad-claude/ipc-contracts":  path.resolve(__dirname, "../../packages/ipc-contracts/src/index.ts"),
  "@bmad-claude/pty-bridge":     path.resolve(__dirname, "../../packages/pty-bridge/src/index.ts"),
  "@bmad-claude/workflow-engine":path.resolve(__dirname, "../../packages/workflow-engine/src/index.ts"),
  "@bmad-claude/bmad-registry":  path.resolve(__dirname, "../../packages/bmad-registry/src/index.ts"),
  "@bmad-claude/storage":        path.resolve(__dirname, "../../packages/storage/src/index.ts"),
}

export default defineConfig({
  // 主进程：外部化第三方原生模块（node-pty、better-sqlite3 等），
  // workspace 包通过 alias 内联打包（解决 ESM/CJS 冲突）
  main: {
    build: {
      lib: { entry: path.resolve(__dirname, "electron/main.ts") },
    },
    resolve: { alias: workspaceAlias },
    plugins: [externalizeDepsPlugin({ exclude: WORKSPACE_PKGS })],
  },

  // preload：同上
  preload: {
    build: {
      lib: { entry: path.resolve(__dirname, "electron/preload.ts") },
    },
    resolve: { alias: workspaceAlias },
    plugins: [externalizeDepsPlugin({ exclude: WORKSPACE_PKGS })],
  },

  // 渲染进程：React + Tailwind CSS v4（不使用 Node API）
  renderer: {
    root: path.resolve(__dirname, "src"),
    build: {
      rollupOptions: {
        input: path.resolve(__dirname, "src/index.html"),
      },
    },
    resolve: { alias: workspaceAlias },
    plugins: [react(), tailwindcss()],
  },
})
