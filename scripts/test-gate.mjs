#!/usr/bin/env node
/**
 * 测试门禁：不接受"Tests passed"但整份套件被跳过的情况。
 *
 * 背景：vitest 在某个测试文件编译失败时，会把该文件计入 "failed files" 但
 * "Tests" 行只统计成功执行的用例，于是输出可能是
 *   Test Files 1 failed | 12 passed
 *   Tests      121 passed (121)
 * 只看 Tests 行会误判为全绿。本脚本要求：失败文件数 = 0，且被跳过/待定用例数 = 0。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, statSync, readdirSync, existsSync } from "node:fs";
import * as path from "node:path";

/**
 * 门禁 0：dist 必须比 src 新。
 *
 * E2E 测试通过 `node packages/cli/bin/agentx.js` 跑编译产物。若有人改了 src 而没重新 build
 * （例如变异测试改了 src、还原了 src、但 dist 还停留在变异版本），所有 E2E 断言都会在
 * 一个与被测源码不一致的实现上通过 —— 这是无法从测试输出里看出来的假绿。
 */
function checkBuildFreshness() {
  const problems = [];
  for (const pkg of readdirSync("/root/pol-agent/packages")) {
    const srcDir = path.join("/root/pol-agent/packages", pkg, "src");
    const distDir = path.join("/root/pol-agent/packages", pkg, "dist");
    if (!existsSync(srcDir)) continue;
    if (!existsSync(distDir)) {
      problems.push(`${pkg}: dist missing (run tsc -b)`);
      continue;
    }
    const newestSrc = Math.max(
      ...readdirSync(srcDir).filter((f) => f.endsWith(".ts")).map((f) => statSync(path.join(srcDir, f)).mtimeMs),
    );
    const oldestDist = Math.min(
      ...readdirSync(distDir).filter((f) => f.endsWith(".js")).map((f) => statSync(path.join(distDir, f)).mtimeMs),
      0,
    );
    if (oldestDist > 0 && oldestDist < newestSrc) {
      problems.push(`${pkg}: dist is older than src (stale build)`);
    }
  }

  // 内容级校验：mtime 会被无关文件的重建刷新，掩盖漏编译。
  // 这里直接检查 dist 是否导出了 src 里新增的符号。
  // [包, src 里应存在的符号, dist 里应存在的调用片段]
  const symbols = [
    ["core", "dropUnpairedToolCalls", "dropUnpairedToolCalls(request.history"],
    ["core", "truncateHistory", "truncateHistory("],
    ["tools", "createPolicyEngine", "function createPolicyEngine"],
    ["store", "SqliteSessionStore", "class SqliteSessionStore"],
    ["skills", "SkillLoader", "class SkillLoader"],
  ];
  for (const [pkg, sym, marker] of symbols) {
    const distDir = path.join("/root/pol-agent/packages", pkg, "dist");
    const srcDir = path.join("/root/pol-agent/packages", pkg, "src");
    if (!existsSync(distDir) || !existsSync(srcDir)) continue;
    const inSrc = readdirSync(srcDir)
      .filter((f) => f.endsWith(".ts"))
      .some((f) => readFileSync(path.join(srcDir, f), "utf8").includes(`export function ${sym}`) ||
                   readFileSync(path.join(srcDir, f), "utf8").includes(`export class ${sym}`));
    if (!inSrc) continue;
    const inDist = readdirSync(distDir)
      .filter((f) => f.endsWith(".js"))
      .some((f) => readFileSync(path.join(distDir, f), "utf8").includes(marker));
    if (!inDist) problems.push(`${pkg}: dist is missing "${marker}" — stale build, run tsc -b --force`);
  }

  // 变异测试残留标记：审计/调试时常会临时改常量并加标记注释，忘了还原就会发布被削弱的实现。
  const mutantMarkers = [];
  for (const pkg of readdirSync("/root/pol-agent/packages")) {
    const distDir = path.join("/root/pol-agent/packages", pkg, "dist");
    if (!existsSync(distDir)) continue;
    for (const f of readdirSync(distDir).filter((x) => x.endsWith(".js"))) {
      const text = readFileSync(path.join(distDir, f), "utf8");
      if (/MUTANT|AUDIT-ONLY|mutation/i.test(text)) mutantMarkers.push(`${pkg}/dist/${f}`);
    }
  }
  if (mutantMarkers.length > 0) {
    problems.push(`mutation markers left in build output: ${mutantMarkers.join(", ")}`);
  }
  return problems;
}

const freshness = checkBuildFreshness();
if (freshness.length > 0) {
  console.error("GATE FAIL: build output out of sync with source:");
  for (const p of freshness) console.error(`  - ${p}`);
  console.error("GATE: FAIL");
  process.exit(1);
}


const res = spawnSync("npx", ["vitest", "run", "--reporter=json", "--outputFile=/tmp/agentx-vitest.json"], {
  encoding: "utf8",
  shell: false,
});

let report;
try {
  report = JSON.parse(readFileSync("/tmp/agentx-vitest.json", "utf8"));
} catch {
  console.error("GATE FAIL: cannot read vitest json report");
  console.error(res.stdout?.slice(-2000) ?? "");
  process.exit(2);
}

// vitest 自身的退出码是最权威的信号：非 0 意味着有文件无法运行或有断言失败。
// 只在 tests 层过滤 failedFiles 会漏掉"文件编译失败但 testResults 里没有条目"的情况。
if (res.status !== 0) {
  console.error(`GATE FAIL: vitest exited with code ${res.status} (unrunnable suite or failing assertion)`);
  console.error((res.stderr ?? "").split("\n").slice(-15).join("\n"));
  console.error("GATE: FAIL");
  process.exit(1);
}

// vitest 记录下来但未被测试框架处理的错误（例如顶层 import 抛错、afterAll 崩溃）
const unhandled = report.unhandledErrors ?? [];
if (unhandled.length > 0) {
  console.error(`GATE FAIL: ${unhandled.length} unhandled error(s) during the test run`);
  for (const e of unhandled.slice(0, 5)) console.error(`  - ${e.message ?? e}`);
  console.error("GATE: FAIL");
  process.exit(1);
}

const files = report.testResults ?? [];
const failedFiles = files.filter((f) => f.status === "failed" || f.assertionResults?.some((a) => a.status === "failed"));
const passed = files.flatMap((f) => f.assertionResults ?? []).filter((a) => a.status === "passed").length;
const failed = files.flatMap((f) => f.assertionResults ?? []).filter((a) => a.status === "failed").length;
const skipped = files.flatMap((f) => f.assertionResults ?? []).filter((a) => a.status === "pending" || a.status === "todo").length;

console.log(`files=${files.length} passed=${passed} failed=${failed} skipped=${skipped}`);

let bad = false;
if (failedFiles.length > 0) {
  bad = true;
  console.error(`GATE FAIL: ${failedFiles.length} file(s) failed to run:`);
  for (const f of failedFiles) console.error(`  - ${f.name}: ${(f.message ?? "").split("\n")[0]}`);
}
if (failed > 0) {
  bad = true;
  console.error(`GATE FAIL: ${failed} failing test(s)`);
}
if (skipped > 0) {
  bad = true;
  console.error(`GATE FAIL: ${skipped} skipped/pending test(s) — undeclared skips are not allowed (AC14)`);
}
if (passed === 0) {
  bad = true;
  console.error("GATE FAIL: no tests executed");
}

console.log(bad ? "GATE: FAIL" : "GATE: PASS");
process.exit(bad ? 1 : 0);
