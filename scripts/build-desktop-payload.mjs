/**
 * Dựng "payload" cho app máy tính: toàn bộ phần Node mà Tauri sẽ đóng gói kèm.
 *
 * Tauri chỉ lo phần vỏ (cửa sổ, icon, bộ cài). Phần ruột vẫn là server Fastify
 * chạy bằng Node, nên phải gom sẵn:
 *   - dist/          mã đã biên dịch từ TypeScript
 *   - dist/web/public, dist/newsroom/assets   (tsc không chép file không phải .ts)
 *   - node_modules   chỉ phần chạy thật, bỏ đồ dùng để phát triển
 *   - node.exe       chính trình chạy Node, để máy đích không cần cài Node
 *
 * Không gộp được thành một file JS vì HyperFrames kéo theo binary gốc
 * (sharp, rolldown, lightningcss, esbuild) — phải giữ nguyên cây thư mục.
 */

import { execFileSync } from "node:child_process";
import { cp, mkdir, rm, writeFile, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const OUT = path.join(ROOT, "desktop", "src-tauri", "payload");
const BIN = path.join(ROOT, "desktop", "src-tauri", "binaries");

/** Tauri đòi sidecar phải có đuôi là target triple của máy đang build. */
function targetTriple() {
  try {
    return execFileSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" }).trim();
  } catch {
    // Chưa cài Rust thì đoán theo hệ điều hành — lúc build thật sẽ có rustc.
    const guess = {
      win32: "x86_64-pc-windows-msvc",
      darwin: process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin",
      linux: "x86_64-unknown-linux-gnu",
    }[process.platform];
    console.warn(`! chưa có rustc, tạm dùng target triple "${guess}"`);
    return guess;
  }
}

const mb = (n) => (n / 1048576).toFixed(0).padStart(5) + " MB";

async function dirSize(p) {
  if (!existsSync(p)) return 0;
  let total = 0;
  const { readdir } = await import("node:fs/promises");
  for (const e of await readdir(p, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) {
      try {
        total += (await stat(path.join(e.parentPath ?? e.path, e.name))).size;
      } catch { /* file vừa bị xoá */ }
    }
  }
  return total;
}

async function main() {
  console.log("→ dọn thư mục payload cũ");
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  console.log("→ biên dịch TypeScript");
  execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit", shell: true });

  console.log("→ chép mã đã biên dịch");
  await cp(path.join(ROOT, "dist"), path.join(OUT, "dist"), { recursive: true });

  // tsc chỉ dịch .ts, mấy thứ này phải tự chép
  console.log("→ chép giao diện và asset");
  await cp(path.join(ROOT, "src", "web", "public"), path.join(OUT, "dist", "web", "public"), {
    recursive: true,
  });
  await cp(path.join(ROOT, "src", "newsroom", "assets"), path.join(OUT, "dist", "newsroom", "assets"), {
    recursive: true,
  });

  console.log("→ cài thư viện bản chạy thật (bỏ đồ phát triển)");
  const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  await writeFile(
    path.join(OUT, "package.json"),
    JSON.stringify(
      { name: "video-studio-payload", private: true, type: "module", dependencies: pkg.dependencies },
      null,
      2,
    ) + "\n",
  );
  execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--ignore-scripts=false"], {
    cwd: OUT,
    stdio: "inherit",
    shell: true,
  });

  console.log("→ chép trình chạy Node làm sidecar");
  await mkdir(BIN, { recursive: true });
  const triple = targetTriple();
  const ext = process.platform === "win32" ? ".exe" : "";
  await cp(process.execPath, path.join(BIN, `node-${triple}${ext}`));

  console.log("\nxong. dung lượng:");
  for (const [ten, p] of [
    ["mã đã biên dịch", path.join(OUT, "dist")],
    ["thư viện", path.join(OUT, "node_modules")],
    ["node sidecar", path.join(BIN, `node-${triple}${ext}`)],
  ]) {
    const s = existsSync(p) && (await stat(p)).isFile() ? (await stat(p)).size : await dirSize(p);
    console.log(`  ${mb(s)}  ${ten}`);
  }
  console.log(`\n  sidecar: node-${triple}${ext}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
