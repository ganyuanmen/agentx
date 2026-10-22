import { defineConfig } from "vitest/config";
import { builtinModules } from "node:module";

// Node 22 的 node:sqlite 不在 vite 的内置外置名单里，会被改写为裸 "sqlite" 而解析失败。
// 这里把全部 node: 内置模块（含 node:sqlite）显式外置，交给 Node 解析。
const builtins = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  "node:sqlite",
];

export default defineConfig({
  test: {
    include: ["packages/*/tests/**/*.test.ts", "tests/**/*.test.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
    pool: "forks",
    server: {
      deps: {
        external: builtins,
      },
    },
  },
  ssr: {
    external: builtins,
    target: "node",
  },
  optimizeDeps: {
    exclude: ["node:sqlite"],
  },
});
