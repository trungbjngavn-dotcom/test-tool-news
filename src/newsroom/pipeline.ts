/**
 * Pipeline template "newsroom": Project -> giọng đọc -> timeline -> composition -> MP4.
 *
 * Tái sử dụng của repo gốc: `src/tts/*` (4 nhà cung cấp sau một interface chung).
 * Mới ở đây: timeline theo độ dài giọng thật, composer newsroom, và tiến trình
 * phát ra theo sự kiện để giao diện web hiển thị được.
 */

import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

import type { Project } from "./types.js";
import { computeTimeline } from "./timeline.js";
import { composeNewsroom } from "./composer.js";
import { EdgeTtsClient } from "../tts/edge-tts-client.js";
import type { TtsClient } from "../tts/tts-client.js";
import { probeDurationSec, ffmpegConvert } from "./media-probe.js";

export type Progress = (ev: { step: string; detail?: string; pct?: number }) => void;

function ttsFor(p: Project): TtsClient {
  switch (p.voice.provider) {
    case "edge-tts":
      return new EdgeTtsClient({ voice: p.voice.voiceId, rate: p.voice.rate });
    default:
      // Các nhà cung cấp trả phí cần API key trong .env — dùng factory của repo gốc.
      throw new Error(
        `Provider "${p.voice.provider}" cần API key; đặt trong .env rồi dùng createTtsClient(cfg).`,
      );
  }
}

/**
 * Sinh giọng đọc cho mọi beat và ghi `voDurationSec`.
 * Idempotent: beat nào đã có file wav hợp lệ thì bỏ qua — đổi một câu không phải
 * sinh lại cả bài. Xoá file wav của beat để buộc sinh lại.
 */
export async function synthVoices(
  p: Project,
  projectDir: string,
  onProgress: Progress = () => {},
): Promise<Record<string, string>> {
  const voDir = path.join(projectDir, "assets", "vo");
  await mkdir(voDir, { recursive: true });
  const client = ttsFor(p);
  const rel: Record<string, string> = {};

  for (let i = 0; i < p.beats.length; i++) {
    const b = p.beats[i];
    const wav = path.join(voDir, `${b.id}.wav`);
    const mp3 = path.join(voDir, `${b.id}.mp3`);
    rel[b.id] = `assets/vo/${b.id}.wav`;

    if (!existsSync(wav)) {
      onProgress({ step: "tts", detail: `${b.id}: đang sinh giọng…`, pct: i / p.beats.length });
      // EdgeTtsClient đã tự thử lại 4 lần; thêm một vòng ngoài vì dịch vụ
      // thỉnh thoảng từ chối liên tiếp cả chùm.
      let ok = false;
      for (let k = 0; k < 3 && !ok; k++) {
        try {
          await client.generate(b.vo, mp3);
          ok = existsSync(mp3);
        } catch {
          /* thử lại */
        }
        if (!ok) await new Promise((r) => setTimeout(r, 1500 * (k + 1)));
      }
      if (!ok) throw new Error(`Không sinh được giọng đọc cho beat "${b.id}" sau nhiều lần thử.`);
      await ffmpegConvert(mp3, wav, ["-ar", "44100", "-ac", "2"]);
    }

    b.voDurationSec = Math.round((await probeDurationSec(wav)) * 1000) / 1000;
    onProgress({
      step: "tts",
      detail: `${b.id}: ${b.voDurationSec.toFixed(2)}s`,
      pct: (i + 1) / p.beats.length,
    });
  }
  return rel;
}

export interface BuildResult {
  project: Project;
  compositionDir: string;
}

/** Sinh giọng + tính timeline + ghi composition. Chưa render. */
export async function buildProject(
  p: Project,
  projectDir: string,
  onProgress: Progress = () => {},
): Promise<BuildResult> {
  const voicePaths = await synthVoices(p, projectDir, onProgress);

  onProgress({ step: "timeline", detail: "Tính thời lượng từng cảnh…" });
  computeTimeline(p);

  onProgress({ step: "compose", detail: "Dựng composition…" });
  // dọn cảnh cũ để beat bị xoá không còn sót lại
  await rm(path.join(projectDir, "compositions"), { recursive: true, force: true });
  await composeNewsroom({ project: p, outDir: projectDir, voicePaths });

  await writeFile(
    path.join(projectDir, "project.json"),
    JSON.stringify(p, null, 2) + "\n",
    "utf8",
  );
  return { project: p, compositionDir: projectDir };
}

/** Chạy một lệnh hyperframes, đẩy từng dòng stdout ra onProgress. */
export function runHyperframes(
  args: string[],
  cwd: string,
  onLine: (line: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("npx", ["--yes", "hyperframes@0.8.75", ...args], {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const feed = (buf: Buffer) => {
      for (const line of buf.toString().split(/\r?\n/)) {
        const t = line.trim();
        if (t) onLine(t);
      }
    };
    proc.stdout.on("data", feed);
    proc.stderr.on("data", feed);
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`hyperframes ${args[0]} lỗi (exit ${code})`)),
    );
    proc.on("error", reject);
  });
}
