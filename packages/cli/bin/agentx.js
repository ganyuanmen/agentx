#!/usr/bin/env node
// agentx 入口：过滤 ExperimentalWarning（node:sqlite 等），再加载编译产物 dist/main.js。
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...args) => {
  const text = typeof warning === "string" ? warning : (warning?.message ?? "");
  const isExperimentalSqlite =
    (typeof warning === "object" && warning !== null && warning.name === "ExperimentalWarning") ||
    /ExperimentalWarning/i.test(String(args[0] ?? ""));
  if (isExperimentalSqlite && /SQLite|sqlite/i.test(text)) {
    return;
  }
  return originalEmitWarning(warning, ...args);
};

// 内置技能目录定位：仓库根（packages/cli/bin -> ../../..）。
const here = path.dirname(fileURLToPath(import.meta.url));
process.env.AGENTX_REPO_ROOT ??= path.resolve(here, "..", "..", "..");

import("../dist/main.js")
  .then((m) => m.main(process.argv.slice(2)))
  .catch((err) => {
    const message = err && typeof err === "object" && "message" in err ? err.message : String(err);
    process.stderr.write(`agentx: ${message}\n`);
    if (process.env.AGENTX_DEBUG && err && err.stack) process.stderr.write(`${err.stack}\n`);
    process.exit(1);
  });
