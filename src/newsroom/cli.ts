/**
 * CLI kiểm thử pipeline newsroom (không qua giao diện web).
 *
 *   npm run newsroom -- <duong-dan/project.json>
 *
 * Đọc Project, sinh giọng, dựng composition, chạy check. Thêm --render để xuất MP4.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { ProjectSchema } from "./types.js";
import { buildProject, runHyperframes } from "./pipeline.js";

const file = process.argv[2];
const doRender = process.argv.includes("--render");
if (!file) {
  console.error("Cách dùng: npm run newsroom -- <project.json> [--render]");
  process.exit(1);
}

const projectDir = path.dirname(path.resolve(file));
const project = ProjectSchema.parse(JSON.parse(await readFile(file, "utf8")));

const { project: built } = await buildProject(project, projectDir, (ev) =>
  console.log(`  [${ev.step}] ${ev.detail ?? ""}`),
);
console.log(`\nTimeline: ${built.shots!.length} cảnh, tổng ${built.totalSec}s`);
for (const s of built.shots!) {
  console.log(`  ${s.mediaKey.padEnd(6)} ${s.startSec.toFixed(2)} -> ${s.endSec.toFixed(2)}  [${s.beatIds.join(", ")}]`);
}

console.log("\n--- hyperframes check ---");
await runHyperframes(["check"], projectDir, (l) => console.log("  " + l));

if (doRender) {
  console.log("\n--- hyperframes render ---");
  await runHyperframes(["render"], projectDir, (l) => console.log("  " + l));
}
