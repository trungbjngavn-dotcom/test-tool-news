/**
 * Web app chạy tại localhost để dựng video bản tin.
 *
 * Vì sao phải là server chứ không phải trang web thuần: render cần Node +
 * FFmpeg + Chrome headless, trình duyệt không làm được. Chạy local nên đọc
 * thẳng file trong máy, không giới hạn dung lượng, không tốn hạ tầng.
 */

import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyMultipart from "@fastify/multipart";
import { mkdir, readdir, readFile, writeFile, stat, rm, copyFile } from "node:fs/promises";
import { existsSync, createWriteStream } from "node:fs";
import { pipeline as streamPipeline } from "node:stream/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import axios from "axios";

import { ProjectSchema, emptyProject, type Project } from "../newsroom/types.js";
import { buildProject, runHyperframes, synthVoices } from "../newsroom/pipeline.js";
import { computeTimeline } from "../newsroom/timeline.js";
import { makeThumb, normalizeImage, probeDurationSec, probeSize } from "../newsroom/media-probe.js";
import { extractArticle, splitToBeatText } from "./extract.js";
import { enqueue, getJob, subscribe } from "./jobs.js";
import { EdgeTtsClient } from "../tts/edge-tts-client.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const PROJECTS = path.join(ROOT, "projects");
const BUNDLED = path.join(ROOT, "src", "newsroom", "assets");
const PORT = Number(process.env.PORT ?? 5174);

const app = Fastify({ logger: false, bodyLimit: 64 * 1024 * 1024 });
await app.register(fastifyMultipart, { limits: { fileSize: 1024 * 1024 * 1024 } });
await app.register(fastifyStatic, { root: path.join(HERE, "public"), prefix: "/" });

const slug = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "du-an";

const dirOf = (id: string) => path.join(PROJECTS, id);

/** Chặn path traversal: mọi đường dẫn phải nằm trong thư mục dự án. */
function safeJoin(base: string, rel: string): string {
  const p = path.resolve(base, rel);
  if (p !== base && !p.startsWith(base + path.sep)) throw new Error("Đường dẫn không hợp lệ");
  return p;
}

async function loadProject(id: string): Promise<Project> {
  const raw = await readFile(path.join(dirOf(id), "project.json"), "utf8");
  return ProjectSchema.parse(JSON.parse(raw));
}
async function saveProject(id: string, p: Project): Promise<void> {
  await writeFile(path.join(dirOf(id), "project.json"), JSON.stringify(p, null, 2) + "\n", "utf8");
}

// ───────────────────────────────────────────────── dự án

app.get("/api/projects", async () => {
  await mkdir(PROJECTS, { recursive: true });
  const names = await readdir(PROJECTS, { withFileTypes: true });
  const out = [];
  for (const d of names) {
    if (!d.isDirectory()) continue;
    const f = path.join(PROJECTS, d.name, "project.json");
    if (!existsSync(f)) continue;
    try {
      const p = JSON.parse(await readFile(f, "utf8"));
      const st = await stat(f);
      out.push({
        id: d.name,
        title: p.title ?? d.name,
        beats: p.beats?.length ?? 0,
        totalSec: p.totalSec ?? null,
        updatedAt: st.mtimeMs,
      });
    } catch {
      /* bỏ qua dự án hỏng */
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
});

app.post("/api/projects", async (req) => {
  const { title } = (req.body ?? {}) as { title?: string };
  const name = title?.trim() || "Bản tin mới";
  let id = slug(name);
  let n = 1;
  while (existsSync(dirOf(id))) id = `${slug(name)}-${++n}`;

  await mkdir(path.join(dirOf(id), "assets", "media"), { recursive: true });
  await mkdir(path.join(dirOf(id), "assets", "brand"), { recursive: true });
  await mkdir(path.join(dirOf(id), "assets", "outro"), { recursive: true });
  // badge mặc định để dự án mới hiển thị đúng ngay
  if (existsSync(path.join(BUNDLED, "badge.png"))) {
    await copyFile(path.join(BUNDLED, "badge.png"), path.join(dirOf(id), "assets", "brand", "badge.png"));
  }
  const p = emptyProject(name);
  await saveProject(id, p);
  return { id, project: p };
});

app.get("/api/projects/:id", async (req) => {
  const { id } = req.params as { id: string };
  return { id, project: await loadProject(id) };
});

app.put("/api/projects/:id", async (req) => {
  const { id } = req.params as { id: string };
  const p = ProjectSchema.parse(req.body);
  await saveProject(id, p);
  return { ok: true };
});

app.delete("/api/projects/:id", async (req) => {
  const { id } = req.params as { id: string };
  await rm(dirOf(id), { recursive: true, force: true });
  return { ok: true };
});

/**
 * Ghi media mới thẳng vào project.json. Nếu chỉ để client giữ trong bộ nhớ rồi
 * lưu sau, người dùng tải ảnh lên xong đóng trình duyệt là mất liên kết.
 */
async function persistMedia(
  id: string,
  added: Array<{ key?: string; src?: string; kind?: string; error?: string }>,
): Promise<void> {
  const ok = added.filter((a) => a.key && a.src && !a.error);
  if (ok.length === 0) return;
  const p = await loadProject(id);
  for (const a of ok) {
    p.media[a.key!] = {
      src: a.src!,
      kind: a.kind === "video" ? "video" : "image",
      position: "50% 50%",
      mediaStartSec: 0,
      useSourceAudio: false,
    };
  }
  await saveProject(id, p);
}

// ───────────────────────────────────────────────── media

/** Upload file từ máy (trình duyệt không cho biết đường dẫn thật nên phải gửi bytes). */
app.post("/api/projects/:id/media", async (req) => {
  const { id } = req.params as { id: string };
  const dir = path.join(dirOf(id), "assets", "media");
  await mkdir(dir, { recursive: true });

  const added: any[] = [];
  for await (const part of (req as any).files()) {
    const ext = (path.extname(part.filename) || ".bin").toLowerCase();
    const isVideo = [".mp4", ".mov", ".webm", ".mkv", ".m4v"].includes(ext);
    const key = `m${Date.now().toString(36)}${added.length}`;
    const raw = path.join(dir, `${key}-raw${ext}`);
    await streamPipeline(part.file, createWriteStream(raw));

    let finalPath: string;
    if (isVideo) {
      finalPath = path.join(dir, `${key}${ext}`);
      await copyFile(raw, finalPath);
      await rm(raw, { force: true });
    } else {
      // ảnh báo thường rất lớn (8000px); thu về 2400px cho render nhanh
      finalPath = path.join(dir, `${key}.jpg`);
      await normalizeImage(raw, finalPath);
      await rm(raw, { force: true });
    }
    const rel = path.relative(dirOf(id), finalPath).replace(/\\/g, "/");
    const thumb = path.join(dirOf(id), "assets", "media", `${key}-thumb.jpg`);
    try { await makeThumb(finalPath, thumb); } catch { /* không có thumb cũng không sao */ }

    added.push({
      key,
      src: rel,
      kind: isVideo ? "video" : "image",
      thumb: `assets/media/${key}-thumb.jpg`,
      size: await probeSize(finalPath),
      durationSec: isVideo ? await probeDurationSec(finalPath).catch(() => null) : null,
      originalName: part.filename,
    });
  }
  await persistMedia(id, added);
  return { added };
});

/** Thêm media bằng ĐƯỜNG DẪN có sẵn trên máy — không cần upload lại. */
app.post("/api/projects/:id/media-from-path", async (req) => {
  const { id } = req.params as { id: string };
  const { filePath } = req.body as { filePath: string };
  if (!filePath || !existsSync(filePath)) {
    throw new Error(`Không tìm thấy file: ${filePath}`);
  }
  const dir = path.join(dirOf(id), "assets", "media");
  await mkdir(dir, { recursive: true });
  const ext = path.extname(filePath).toLowerCase();
  const isVideo = [".mp4", ".mov", ".webm", ".mkv", ".m4v"].includes(ext);
  const key = `m${Date.now().toString(36)}`;
  const finalPath = path.join(dir, isVideo ? `${key}${ext}` : `${key}.jpg`);
  if (isVideo) await copyFile(filePath, finalPath);
  else await normalizeImage(filePath, finalPath);

  const thumb = path.join(dir, `${key}-thumb.jpg`);
  try { await makeThumb(finalPath, thumb); } catch { /* bỏ qua */ }
  const added = [{
      key,
      src: `assets/media/${key}${isVideo ? ext : ".jpg"}`,
      kind: isVideo ? "video" : "image",
      thumb: `assets/media/${key}-thumb.jpg`,
      size: await probeSize(finalPath),
      durationSec: isVideo ? await probeDurationSec(finalPath).catch(() => null) : null,
      originalName: path.basename(filePath),
  }];
  await persistMedia(id, added);
  return { added };
});

/** Duyệt thư mục trên máy để chọn file mà không phải upload. */
app.get("/api/browse", async (req) => {
  const { dir } = req.query as { dir?: string };
  const target = dir && dir.trim() ? dir : process.env.USERPROFILE || process.env.HOME || ROOT;
  const entries = await readdir(target, { withFileTypes: true });
  const media = /\.(jpe?g|png|webp|mp4|mov|webm|mkv|m4v)$/i;
  return {
    dir: path.resolve(target),
    parent: path.dirname(path.resolve(target)),
    folders: entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).slice(0, 500),
    files: entries.filter((e) => e.isFile() && media.test(e.name)).map((e) => e.name).slice(0, 500),
  };
});

/** Phục vụ file trong dự án (thumb, media, video output) cho giao diện. */
app.get("/api/projects/:id/file/*", async (req, reply) => {
  const { id } = req.params as { id: string; "*": string };
  const rel = (req.params as any)["*"] as string;
  const abs = safeJoin(path.resolve(dirOf(id)), rel);
  if (!existsSync(abs)) return reply.code(404).send({ error: "not found" });
  const ext = path.extname(abs).toLowerCase();
  const types: Record<string, string> = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
    ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
    ".wav": "audio/wav", ".mp3": "audio/mpeg",
  };
  return reply.type(types[ext] ?? "application/octet-stream").send(await readFile(abs));
});

// ───────────────────────────────────────────────── outro / badge

app.post("/api/projects/:id/outro", async (req) => {
  const { id } = req.params as { id: string };
  const data = await (req as any).file();
  const dir = path.join(dirOf(id), "assets", "outro");
  await mkdir(dir, { recursive: true });
  const ext = path.extname(data.filename) || ".mp4";
  const dest = path.join(dir, `outro${ext}`);
  await streamPipeline(data.file, createWriteStream(dest));
  const durationSec = Math.round((await probeDurationSec(dest)) * 1000) / 1000;
  const src = `assets/outro/outro${ext}`;
  const proj = await loadProject(id);
  proj.outro = { src, durationSec };
  await saveProject(id, proj);
  return { src, durationSec };
});

app.post("/api/projects/:id/badge", async (req) => {
  const { id } = req.params as { id: string };
  const data = await (req as any).file();
  const dir = path.join(dirOf(id), "assets", "brand");
  await mkdir(dir, { recursive: true });
  const dest = path.join(dir, "badge.png");
  await streamPipeline(data.file, createWriteStream(dest));
  const size = await probeSize(dest);
  const proj = await loadProject(id);
  proj.brand.badgeSrc = "assets/brand/badge.png";
  if (size) {
    proj.brand.badgeWidth = size.width;
    proj.brand.badgeHeight = size.height;
  }
  await saveProject(id, proj);
  return { src: "assets/brand/badge.png", size };
});

// ───────────────────────────────────────────────── trích xuất bài báo

app.post("/api/extract", async (req) => {
  const { url } = req.body as { url: string };
  const ex = await extractArticle(url);
  const beats = ex.paragraphs.flatMap((p) => splitToBeatText(p)).slice(0, 12);
  return { ...ex, suggestedBeats: beats };
});

/** Cắt một khối văn bản dài thành các nhịp vừa màn hình. */
app.post("/api/split-text", async (req) => {
  const { text, maxLen } = req.body as { text: string; maxLen?: number };
  const paragraphs = String(text ?? "")
    .split(/\n+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const beats = paragraphs.flatMap((p) => splitToBeatText(p, maxLen ?? 140));
  return { beats };
});

/** Tải ảnh từ bài báo về dự án. */
app.post("/api/projects/:id/media-from-url", async (req) => {
  const { id } = req.params as { id: string };
  const { urls } = req.body as { urls: string[] };
  const dir = path.join(dirOf(id), "assets", "media");
  await mkdir(dir, { recursive: true });

  const added: any[] = [];
  for (const u of urls) {
    try {
      const resp = await axios.get<ArrayBuffer>(u, {
        responseType: "arraybuffer", timeout: 30000,
        headers: { "User-Agent": "Mozilla/5.0", Referer: new URL(u).origin },
      });
      const key = `m${Date.now().toString(36)}${added.length}`;
      const raw = path.join(dir, `${key}-raw`);
      await writeFile(raw, Buffer.from(resp.data));
      const finalPath = path.join(dir, `${key}.jpg`);
      await normalizeImage(raw, finalPath);
      await rm(raw, { force: true });
      const thumb = path.join(dir, `${key}-thumb.jpg`);
      try { await makeThumb(finalPath, thumb); } catch { /* bỏ qua */ }
      added.push({
        key, src: `assets/media/${key}.jpg`, kind: "image",
        thumb: `assets/media/${key}-thumb.jpg`,
        size: await probeSize(finalPath), originalName: u.split("/").pop(),
      });
    } catch (e: any) {
      added.push({ error: String(e?.message ?? e), url: u });
    }
  }
  await persistMedia(id, added);
  return { added };
});

// ───────────────────────────────────────────────── nghe thử giọng

app.post("/api/projects/:id/voice-preview", async (req) => {
  const { id } = req.params as { id: string };
  const { text, voiceId, rate } = req.body as { text: string; voiceId: string; rate: string };
  const dir = path.join(dirOf(id), "assets", "preview");
  await mkdir(dir, { recursive: true });
  const dest = path.join(dir, "voice-preview.mp3");
  await new EdgeTtsClient({ voice: voiceId, rate }).generate(text, dest);
  const durationSec = Math.round((await probeDurationSec(dest)) * 1000) / 1000;
  return { src: `assets/preview/voice-preview.mp3`, durationSec, t: Date.now() };
});

app.get("/api/voices", async () => [
  { id: "vi-VN-NamMinhNeural", label: "Nam Minh (nam)" },
  { id: "vi-VN-HoaiMyNeural", label: "Hoài My (nữ)" },
]);

// ───────────────────────────────────────────────── build / preview / render

app.post("/api/projects/:id/build", async (req) => {
  const { id } = req.params as { id: string };
  const job = enqueue("build", id, async (h) => {
    const p = await loadProject(id);
    await buildProject(p, dirOf(id), (ev) => h.log(`[${ev.step}] ${ev.detail ?? ""}`));
    h.log("Chạy kiểm tra…");
    // Runtime check thỉnh thoảng timeout do protocol; thử lại một lần.
    try {
      await runHyperframes(["check"], dirOf(id), (l) => h.log(l));
    } catch {
      h.log("Kiểm tra lỗi tạm thời, thử lại…");
      await runHyperframes(["check"], dirOf(id), (l) => h.log(l));
    }
    const fresh = await loadProject(id);
    return { totalSec: fresh.totalSec, shots: fresh.shots?.length ?? 0 };
  });
  return { jobId: job.id };
});

app.post("/api/projects/:id/preview", async (req) => {
  const { id } = req.params as { id: string };
  const job = enqueue("preview", id, async (h) => {
    // Chỉ lấy PORT từ output. Tên dự án hyperframes in ra không đáng tin khi nó
    // tái dùng server nền (nó lấy tên thư mục gốc chứ không phải thư mục dự án),
    // nên ta tự ghép fragment bằng id thật — trùng tên thư mục mà Studio dùng.
    let port: number | null = null;
    await runHyperframes(["preview", "--background"], dirOf(id), (l) => {
      h.log(l);
      const m = l.match(/https?:\/\/localhost:(\d+)/);
      if (m && port === null) port = Number(m[1]);
    });
    if (port === null) throw new Error("Không đọc được cổng của Studio từ log.");
    const url = `http://localhost:${port}/#project/${id}`;
    h.log(`Studio: ${url}`);
    return { url, port };
  });
  return { jobId: job.id };
});

app.post("/api/projects/:id/preview-stop", async (req) => {
  const { id } = req.params as { id: string };
  const job = enqueue("preview-stop", id, async (h) => {
    await runHyperframes(["preview", dirOf(id), "--stop"], dirOf(id), (l) => h.log(l));
    return { stopped: true };
  });
  return { jobId: job.id };
});

app.post("/api/projects/:id/render", async (req) => {
  const { id } = req.params as { id: string };
  const job = enqueue("render", id, async (h) => {
    await runHyperframes(["render"], dirOf(id), (l) => h.log(l));
    const rdir = path.join(dirOf(id), "renders");
    const files = existsSync(rdir)
      ? (await readdir(rdir)).filter((f) => f.endsWith(".mp4"))
      : [];
    if (files.length === 0) throw new Error("Render xong nhưng không thấy file MP4.");
    const withTime = await Promise.all(
      files.map(async (f) => ({ f, m: (await stat(path.join(rdir, f))).mtimeMs })),
    );
    withTime.sort((a, b) => b.m - a.m);
    const newest = withTime[0].f;
    return {
      file: newest,
      url: `/api/projects/${id}/file/renders/${encodeURIComponent(newest)}`,
      absolutePath: path.join(rdir, newest),
      durationSec: await probeDurationSec(path.join(rdir, newest)).catch(() => null),
    };
  });
  return { jobId: job.id };
});

/** Mở File Explorer và chọn sẵn file — tiện vì app chạy ngay trên máy. */
app.post("/api/reveal", async (req) => {
  const { absolutePath } = req.body as { absolutePath: string };
  if (!absolutePath || !existsSync(absolutePath)) {
    throw new Error("Không tìm thấy file để mở.");
  }
  spawn("explorer.exe", [`/select,${absolutePath}`], { detached: true, stdio: "ignore" }).unref();
  return { ok: true };
});

// ───────────────────────────────────────────────── theo dõi job (SSE)

app.get("/api/jobs/:jobId/stream", async (req, reply) => {
  const { jobId } = req.params as { jobId: string };
  const job = getJob(jobId);
  if (!job) return reply.code(404).send({ error: "job không tồn tại" });

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Một client ngắt giữa chừng không được phép làm sập server: mọi lần ghi đều
  // qua cổng `closed`, và ServerResponse phải có handler 'error' riêng — lỗi
  // stream phát ra bất đồng bộ nên try/catch quanh lời gọi không bắt được.
  let closed = false;
  let off = () => {};
  const finish = () => {
    if (closed) return;
    closed = true;
    off();
    try { reply.raw.end(); } catch { /* đã đóng */ }
  };
  reply.raw.on("error", finish);
  req.raw.on("close", finish);

  const send = (o: unknown) => {
    if (closed || reply.raw.writableEnded) return;
    try { reply.raw.write(`data: ${JSON.stringify(o)}

`); } catch { finish(); }
  };

  off = subscribe(jobId, (j, line) => {
    if (line) send({ line });
    if (j.state === "done" || j.state === "error") {
      send({ state: j.state, result: j.result, error: j.error });
      finish();
    }
  });

  for (const l of job.lines) send({ line: l });
  if (job.state === "done" || job.state === "error") {
    send({ state: job.state, result: job.result, error: job.error });
    finish();
  } else {
    send({ state: job.state });
  }
});

// ───────────────────────────────────────────────── an toàn

// Trả lỗi dạng JSON để giao diện hiện được thông báo thay vì trang trắng.
app.setErrorHandler((err: unknown, _req, reply) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("[api]", msg);
  reply.code(400).send({ error: msg });
});

// Lưới cuối: một lỗi lẻ (client ngắt kết nối, ffmpeg chết bất thường) không
// được phép giết cả phiên làm việc đang dở. Vẫn in ra để còn sửa.
process.on("uncaughtException", (e) => console.error("[uncaught]", e));
process.on("unhandledRejection", (e) => console.error("[unhandled]", e));

// ───────────────────────────────────────────────── khởi động

await mkdir(PROJECTS, { recursive: true });
await app.listen({ port: PORT, host: "127.0.0.1" });
console.log(`\n  Video Studio đang chạy:  http://localhost:${PORT}\n`);
