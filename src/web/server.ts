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

import { ProjectSchema, emptyProject, type Project, type Beat } from "../newsroom/types.js";
import { buildProject, runHyperframes, synthVoices } from "../newsroom/pipeline.js";
import { computeTimeline } from "../newsroom/timeline.js";
import { makeThumb, normalizeImage, probeDurationSec, probeSize } from "../newsroom/media-probe.js";
import { extractArticle, splitToBeatText } from "./extract.js";
import {
  layTinMoi, kichBanTuBaiBao, docBang, tachCsv, linkSheetSangCsv,
} from "./autofill.js";
import { enqueue, getJob, subscribe } from "./jobs.js";
import { EdgeTtsClient } from "../tts/edge-tts-client.js";
import { VOICES, RATES, PITCHES } from "../newsroom/voices.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

/**
 * Nơi lưu dự án của người dùng.
 *
 * Chạy từ mã nguồn thì để ngay trong repo cho tiện. Nhưng bản đóng gói thành
 * app cài vào máy nằm ở thư mục chỉ-đọc (Program Files), nên app truyền
 * VIDEO_STUDIO_DATA trỏ sang thư mục tài liệu của người dùng.
 */
const PROJECTS = process.env.VIDEO_STUDIO_DATA
  ? path.resolve(process.env.VIDEO_STUDIO_DATA, "projects")
  : path.join(ROOT, "projects");

/**
 * Asset đi kèm (logo, bản đồ). Chạy từ mã nguồn thì nằm ở src/newsroom/assets;
 * sau khi biên dịch, script đóng gói chép sang cạnh file đã build.
 */
const BUNDLED = [
  path.join(HERE, "..", "newsroom", "assets"),
  path.join(ROOT, "src", "newsroom", "assets"),
].find((d) => existsSync(d)) ?? path.join(ROOT, "src", "newsroom", "assets");

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

/** Lỗi có kèm mã HTTP để trình duyệt phân biệt "không có" với "hỏng". */
class HttpError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

async function loadProject(id: string): Promise<Project> {
  const file = path.join(dirOf(id), "project.json");
  if (!existsSync(file)) throw new HttpError(404, `Không có dự án "${id}".`);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new HttpError(500, `Không đọc được dự án "${id}".`);
  }
  try {
    return ProjectSchema.parse(JSON.parse(raw));
  } catch (e) {
    throw new HttpError(422, `project.json của "${id}" không hợp lệ: ${(e as Error).message}`);
  }
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

/** Tạo thư mục dự án trống kèm logo mặc định. Dùng chung cho mọi cách tạo. */
async function taoDuAn(title?: string): Promise<{ id: string; project: Project }> {
  const name = title?.trim() || "Bản tin mới";
  let id = slug(name);
  let n = 1;
  while (existsSync(dirOf(id))) id = `${slug(name)}-${++n}`;

  await mkdir(path.join(dirOf(id), "assets", "media"), { recursive: true });
  await mkdir(path.join(dirOf(id), "assets", "brand"), { recursive: true });
  await mkdir(path.join(dirOf(id), "assets", "outro"), { recursive: true });
  if (existsSync(path.join(BUNDLED, "badge.png"))) {
    await copyFile(path.join(BUNDLED, "badge.png"), path.join(dirOf(id), "assets", "brand", "badge.png"));
  }
  const project = emptyProject(name);
  await saveProject(id, project);
  return { id, project };
}

/**
 * Tải một loạt ảnh từ URL vào dự án, trả về danh sách khoá media theo đúng thứ
 * tự đầu vào. Ảnh nào tải hỏng thì bỏ qua chứ không làm hỏng cả mẻ.
 */
async function taiAnhVaoDuAn(id: string, urls: string[]): Promise<string[]> {
  const dir = path.join(dirOf(id), "assets", "media");
  await mkdir(dir, { recursive: true });
  const khoa: string[] = [];

  for (const [i, u] of urls.entries()) {
    try {
      const resp = await axios.get<ArrayBuffer>(u, {
        responseType: "arraybuffer",
        timeout: 30000,
        headers: { "User-Agent": "Mozilla/5.0", Referer: new URL(u).origin },
      });
      const key = `m${Date.now().toString(36)}${i}`;
      const raw = path.join(dir, `${key}-raw`);
      await writeFile(raw, Buffer.from(resp.data));
      const finalPath = path.join(dir, `${key}.jpg`);
      await normalizeImage(raw, finalPath);
      await rm(raw, { force: true });
      try { await makeThumb(finalPath, path.join(dir, `${key}-thumb.jpg`)); } catch { /* bỏ qua */ }

      const size = await probeSize(finalPath);
      const p = await loadProject(id);
      p.media[key] = {
        src: `assets/media/${key}.jpg`,
        kind: "image",
        position: "50% 50%",
        mediaStartSec: 0,
        useSourceAudio: false,
        width: size?.width,
        height: size?.height,
      };
      await saveProject(id, p);
      khoa.push(key);
    } catch {
      /* ảnh hỏng thì bỏ, dự án vẫn dùng được */
    }
  }
  return khoa;
}

/** Rải đều media cho các nhịp; ít ảnh hơn nhịp thì dùng lại vòng tròn. */
function raiAnh(beats: Beat[], khoa: string[]): void {
  if (khoa.length === 0) return;
  beats.forEach((b, i) => {
    b.mediaKey = khoa[i % khoa.length];
  });
}

app.post("/api/projects", async (req) => {
  const { title } = (req.body ?? {}) as { title?: string };
  return await taoDuAn(title);
});

app.get("/api/projects/:id", async (req) => {
  const { id } = req.params as { id: string };
  const project = await loadProject(id);
  // Dự án tạo ngoài giao diện (bằng CLI, hoặc bản cũ chưa có trường width/height)
  // thiếu hai thứ giao diện cần: kích thước thật để cảnh báo ảnh nhỏ, và file
  // thumbnail để hiện trong thư viện. Bù cả hai ngay lần mở đầu tiên.
  let filled = false;
  for (const [key, m] of Object.entries(project.media)) {
    const abs = path.join(dirOf(id), m.src);
    if (!existsSync(abs)) continue;

    if (!m.width || !m.height) {
      const size = await probeSize(abs);
      if (size) {
        m.width = size.width;
        m.height = size.height;
        filled = true;
      }
    }

    const thumb = path.join(dirOf(id), "assets", "media", `${key}-thumb.jpg`);
    if (!existsSync(thumb)) {
      try {
        await makeThumb(abs, thumb);
      } catch {
        /* không dựng được thumb thì giao diện tự ẩn ảnh đi */
      }
    }
  }
  if (filled) await saveProject(id, project);
  return { id, project };
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
  added: Array<{
    key?: string; src?: string; kind?: string; error?: string;
    size?: { width: number; height: number } | null;
  }>,
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
      width: a.size?.width,
      height: a.size?.height,
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

// ─────────────────────────────────── tin mới trong ngày + tự điền dự án

/** Danh sách tin mới theo từ khoá, mặc định "tin mới ielts". */
app.get("/api/news", async (req) => {
  const { q, limit } = req.query as { q?: string; limit?: string };
  const tuKhoa = q?.trim() || "tin mới ielts";
  const { items, cuaSoGio } = await layTinMoi(tuKhoa, Number(limit) || 10);
  return { q: tuKhoa, items, cuaSoGio };
});

/**
 * Từ một link bài báo -> dự án điền sẵn chữ và ảnh.
 *
 * Dùng cho cả ô "Lấy từ bài báo" lẫn việc bấm vào một tin trong danh sách.
 * Link của Google News là trang chuyển hướng nên phải gỡ ra link báo gốc trước.
 */
app.post("/api/projects/from-article", async (req) => {
  const { url } = req.body as { url: string };
  if (!url?.trim()) throw new HttpError(400, "Chưa có link bài báo.");

  const that = url.trim();
  // Google News bọc link trong token riêng, phải gọi API của họ mới gỡ được —
  // báo rõ để người dùng lấy link báo gốc thay vì để nó lỗi khó hiểu.
  if (/news\.google\.com/i.test(that)) {
    throw new HttpError(400, "Link Google News không dùng trực tiếp được. Mở bài rồi copy link của báo gốc.");
  }
  const ex = await extractArticle(that);
  if (!ex.title && ex.paragraphs.length === 0) {
    throw new HttpError(422, "Không đọc được nội dung bài này. Thử link khác xem sao.");
  }

  const kb = kichBanTuBaiBao(ex);
  // Chỉ có card mở đầu nghĩa là không moi được câu nào — tạo dự án rỗng chỉ
  // tổ làm rác, báo lỗi để người dùng chọn bài khác.
  if (kb.beats.length < 2) {
    throw new HttpError(422, "Bài này không lấy được nội dung (trang dựng bằng JavaScript). Thử bài khác.");
  }
  const { id } = await taoDuAn(kb.tieuDe);

  const khoa = await taiAnhVaoDuAn(id, kb.anh);
  raiAnh(kb.beats, khoa);

  const p = await loadProject(id);
  p.beats = kb.beats;
  if (ex.siteName) p.brand.sourceLabel = `Nguồn : ${ex.siteName}`;
  await saveProject(id, p);

  return { id, soNhip: kb.beats.length, soAnh: khoa.length, nguon: that };
});

/**
 * Từ một file bảng (csv/tsv/xlsx) hoặc link Google Sheets -> dự án điền sẵn.
 *
 * Cột nhận theo tên ở hàng đầu: chữ/text, giọng/vo, ảnh/image. Ô ảnh nhận cả
 * URL lẫn đường dẫn file trong máy.
 */
app.post("/api/projects/from-sheet", async (req) => {
  let bang: string[][] = [];
  let ten = "Bản tin từ bảng";

  const ct = String(req.headers["content-type"] ?? "");
  if (ct.includes("multipart/form-data")) {
    const file = await (req as any).file();
    if (!file) throw new HttpError(400, "Chưa chọn file.");
    ten = String(file.filename ?? ten).replace(/[.][^.]+$/, "");
    const buf: Buffer = await file.toBuffer();
    bang = /[.](xlsx|xls)$/i.test(file.filename ?? "")
      ? await docXlsx(buf)
      : tachCsv(buf.toString("utf8"));
  } else {
    const { url } = (req.body ?? {}) as { url?: string };
    if (!url?.trim()) throw new HttpError(400, "Chưa có file hay link bảng.");
    const csv = linkSheetSangCsv(url.trim()) ?? url.trim();
    const { data } = await axios.get<string>(csv, { timeout: 30000, responseType: "text" });
    bang = tachCsv(data);
  }

  const dong = docBang(bang);
  if (dong.length === 0) throw new HttpError(422, "Bảng không có dòng nào đọc được.");

  const { id } = await taoDuAn(ten);

  // ô ảnh có thể là URL hoặc đường dẫn trong máy; gom lại tải/chép một lượt
  const urls = [...new Set(dong.map((d) => d.anh).filter((a) => /^https?:\/\//i.test(a)))];
  const mapUrl = new Map<string, string>();
  const khoaUrl = await taiAnhVaoDuAn(id, urls);
  urls.forEach((u, i) => { if (khoaUrl[i]) mapUrl.set(u, khoaUrl[i]); });

  for (const d of dong) {
    if (!d.anh || mapUrl.has(d.anh) || /^https?:\/\//i.test(d.anh)) continue;
    const k = await themAnhTuDuongDan(id, d.anh);
    if (k) mapUrl.set(d.anh, k);
  }

  const beats: Beat[] = dong.map((d, i) => ({
    id: `b${i + 1}`,
    mediaKey: mapUrl.get(d.anh) ?? khoaUrl[0] ?? "",
    kind: "beat",
    text: d.text,
    date: "",
    headline: [],
    vo: d.vo || d.text,
  }));

  const p = await loadProject(id);
  p.beats = beats;
  await saveProject(id, p);
  return { id, soNhip: beats.length, soAnh: mapUrl.size };
});

/** Chép một ảnh có sẵn trong máy vào dự án, trả về khoá media. */
async function themAnhTuDuongDan(id: string, duongDan: string): Promise<string | null> {
  if (!existsSync(duongDan)) return null;
  try {
    const dir = path.join(dirOf(id), "assets", "media");
    await mkdir(dir, { recursive: true });
    const key = `m${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
    const finalPath = path.join(dir, `${key}.jpg`);
    await normalizeImage(duongDan, finalPath);
    try { await makeThumb(finalPath, path.join(dir, `${key}-thumb.jpg`)); } catch { /* bỏ qua */ }
    const size = await probeSize(finalPath);
    const p = await loadProject(id);
    p.media[key] = {
      src: `assets/media/${key}.jpg`, kind: "image", position: "50% 50%",
      mediaStartSec: 0, useSourceAudio: false, width: size?.width, height: size?.height,
    };
    await saveProject(id, p);
    return key;
  } catch {
    return null;
  }
}

/** Đọc sheet đầu tiên của file Excel thành mảng hai chiều. */
async function docXlsx(buf: Buffer): Promise<string[][]> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(buf, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: "" });
}

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
  const { text, voiceId, rate, pitch } = req.body as
    { text: string; voiceId: string; rate: string; pitch?: string };
  const dir = path.join(dirOf(id), "assets", "preview");
  await mkdir(dir, { recursive: true });
  const dest = path.join(dir, "voice-preview.mp3");
  await new EdgeTtsClient({ voice: voiceId, rate, pitch: pitch ?? "+0Hz" }).generate(text, dest);
  const durationSec = Math.round((await probeDurationSec(dest)) * 1000) / 1000;
  return { src: `assets/preview/voice-preview.mp3`, durationSec, t: Date.now() };
});

app.get("/api/voices", async () => ({ voices: VOICES, rates: RATES, pitches: PITCHES }));

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
  // Mỗi hệ điều hành một lệnh khác nhau. Windows và macOS chọn sẵn được file;
  // trên Linux thì chỉ mở được thư mục chứa nó.
  const [cmd, args] =
    process.platform === "win32"
      ? ["explorer.exe", [`/select,${absolutePath}`]]
      : process.platform === "darwin"
        ? ["open", ["-R", absolutePath]]
        : ["xdg-open", [path.dirname(absolutePath)]];
  spawn(cmd as string, args as string[], { detached: true, stdio: "ignore" }).unref();
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
app.setErrorHandler((err: unknown, req, reply) => {
  const msg = err instanceof Error ? err.message : String(err);
  const code = typeof (err as any)?.statusCode === "number" ? (err as any).statusCode : 400;
  console.error("[api]", req.method, req.url, "->", code, msg);
  reply.code(code).send({ error: msg });
});

// Lưới cuối: một lỗi lẻ (client ngắt kết nối, ffmpeg chết bất thường) không
// được phép giết cả phiên làm việc đang dở. Vẫn in ra để còn sửa.
process.on("uncaughtException", (e) => console.error("[uncaught]", e));
process.on("unhandledRejection", (e) => console.error("[unhandled]", e));

// ───────────────────────────────────────────────── khởi động

await mkdir(PROJECTS, { recursive: true });
await app.listen({ port: PORT, host: "127.0.0.1" });
console.log(`\n  Tool News đang chạy:  http://localhost:${PORT}\n`);
