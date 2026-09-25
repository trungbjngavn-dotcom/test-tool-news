/** Bọc ffprobe/ffmpeg cho những việc nhỏ: đo thời lượng, đổi định dạng, lấy ảnh đại diện. */

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    proc.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} lỗi (${code}): ${err.slice(-400)}`)),
    );
    proc.on("error", reject);
  });
}

export async function probeDurationSec(file: string): Promise<number> {
  const out = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=nw=1:nk=1",
    `"${file}"`,
  ]);
  const n = Number.parseFloat(out.trim());
  if (!Number.isFinite(n)) throw new Error(`Không đọc được thời lượng: ${file}`);
  return n;
}

export async function probeSize(file: string): Promise<{ width: number; height: number } | null> {
  try {
    const out = await run("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "csv=p=0",
      `"${file}"`,
    ]);
    const [w, h] = out.trim().split(",").map(Number);
    return Number.isFinite(w) && Number.isFinite(h) ? { width: w, height: h } : null;
  } catch {
    return null;
  }
}

export async function ffmpegConvert(input: string, output: string, extra: string[] = []): Promise<void> {
  await run("ffmpeg", ["-v", "error", "-i", `"${input}"`, ...extra, `"${output}"`, "-y"]);
}

/**
 * Cắt im lặng ở đầu và cuối một file giọng đọc.
 *
 * edge-tts luôn chèn sẵn khoảng ~0,25 giây im lặng đầu và ~0,85 giây cuối mỗi
 * câu. Ghép nhiều câu lại thì mỗi chỗ nối hở hơn một giây, nghe rời rạc như đọc
 * từng câu một chứ không phải một đoạn văn liền mạch.
 *
 * Cách làm là mẹo quen thuộc của ffmpeg: bỏ im lặng đầu, đảo ngược, bỏ im lặng
 * đầu lần nữa (chính là phần đuôi), rồi đảo lại. `start_silence` giữ lại một
 * chút im lặng để không cắt cụt phụ âm đầu/cuối.
 */
export async function trimSilence(input: string, output: string): Promise<void> {
  const one =
    "silenceremove=start_periods=1:start_silence=0.04:start_threshold=-42dB:detection=peak";
  await run("ffmpeg", [
    "-v", "error",
    "-i", `"${input}"`,
    "-af", `"${one},areverse,${one},areverse"`,
    "-ar", "44100", "-ac", "2",
    `"${output}"`,
    "-y",
  ]);
}

/** Ảnh đại diện cho giao diện: ảnh thì thu nhỏ, video thì lấy 1 khung. */
export async function makeThumb(input: string, output: string): Promise<void> {
  await mkdir(path.dirname(output), { recursive: true });
  await run("ffmpeg", [
    "-v", "error",
    "-i", `"${input}"`,
    "-frames:v", "1",
    "-vf", "scale=320:-1",
    `"${output}"`,
    "-y",
  ]);
}

/** Ảnh nguồn thường rất lớn; thu về kích thước đủ dùng để render nhanh hơn. */
export async function normalizeImage(input: string, output: string): Promise<void> {
  await run("ffmpeg", [
    "-v", "error",
    "-i", `"${input}"`,
    "-vf", "scale='min(2400,iw)':-1",
    "-q:v", "3",
    `"${output}"`,
    "-y",
  ]);
}
