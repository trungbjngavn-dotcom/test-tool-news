/**
 * Ba nguồn tự điền dự án, dùng chung một bộ khung:
 *
 *   1. một link bài báo          -> extractArticle
 *   2. danh sách tin mới trong ngày  -> Bing News RSS
 *   3. một file sheet (csv/tsv/xlsx) -> đọc bảng
 *
 * Mục đích chung: người dùng không phải copy-paste từng câu và từng ảnh nữa,
 * bấm một cái là có dự án điền sẵn chữ + hình, chỉ việc sửa lại cho gọn.
 */

import axios from "axios";
import * as cheerio from "cheerio";

import { extractArticle, splitToBeatText, type Extracted } from "./extract.js";
import type { Beat } from "../newsroom/types.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

// ───────────────────────────────────────────── tin mới trong ngày

export interface TinTuc {
  title: string;
  link: string;
  source: string;
  pubDate: string;
  /** Link bọc gốc từ RSS, giữ lại để dò lỗi khi cần. */
  linkBoc: string;
}

/**
 * Lấy tin mới theo từ khoá.
 *
 * Dùng Bing News RSS chứ không dùng Google News: Google bọc link trong một token
 * mờ (`CBMi...`) phải gọi API riêng của họ mới gỡ được, rất dễ vỡ. Bing nhúng
 * thẳng URL thật vào tham số `url=` nên chỉ cần tách chuỗi truy vấn.
 */
export async function layTinMoi(tuKhoa: string, soLuong = 10): Promise<TinTuc[]> {
  const url =
    "https://www.bing.com/news/search?q=" +
    encodeURIComponent(tuKhoa) +
    "&format=RSS&setmkt=vi-VN&setlang=vi";
  const { data } = await axios.get<string>(url, {
    timeout: 25000,
    headers: { "User-Agent": UA },
    responseType: "text",
  });

  const $ = cheerio.load(data, { xmlMode: true });
  const ra: TinTuc[] = [];
  const daCo = new Set<string>();

  $("item").each((_, el) => {
    if (ra.length >= soLuong) return;
    const $e = $(el);
    const title = $e.find("title").text().trim();
    const boc = $e.find("link").text().trim();
    if (!title || !boc) return;

    const that = goLinkBing(boc);
    if (!that) return;
    // cùng một tin hay được nhiều báo đăng lại; bỏ trùng theo URL
    if (daCo.has(that)) return;
    daCo.add(that);

    let nguon = "";
    try { nguon = new URL(that).hostname.replace(/^www\./, ""); } catch { /* bỏ qua */ }

    ra.push({
      title,
      link: that,
      linkBoc: boc,
      source: nguon,
      pubDate: $e.find("pubDate").text().trim(),
    });
  });
  return ra;
}

/** Bing bọc link trong apiclick.aspx?...&url=<link thật>. */
function goLinkBing(boc: string): string | null {
  try {
    const u = new URL(boc.replace(/&amp;/g, "&"));
    const that = u.searchParams.get("url");
    if (that) return that;
    return /bing\.com/i.test(u.hostname) ? null : boc;
  } catch {
    return null;
  }
}

// ───────────────────────────────────────────── dựng nhịp từ bài báo

export interface KichBan {
  beats: Beat[];
  anh: string[];
  tieuDe: string;
}

/**
 * Biến một bài báo đã bóc tách thành kịch bản hoàn chỉnh.
 *
 * Nhịp đầu là card mở đầu lấy từ tiêu đề; các nhịp sau là từng đoạn đã cắt vừa
 * khung chữ. Giới hạn số nhịp để video không dài lê thê — người dùng thấy đủ ý
 * rồi tự xoá bớt nhanh hơn là phải tự thêm.
 */
export function kichBanTuBaiBao(ex: Extracted, soNhipToiDa = 8): KichBan {
  const tieuDe = (ex.title || "Bản tin").trim();

  const beats: Beat[] = [
    {
      id: "t0",
      mediaKey: "",
      kind: "title",
      text: "",
      date: ex.date || new Date().toLocaleDateString("vi-VN"),
      headline: cheTieuDe(tieuDe),
      vo: tieuDe,
    },
  ];

  const cau = ex.paragraphs.flatMap((p) => splitToBeatText(p)).slice(0, soNhipToiDa);
  cau.forEach((t, i) => {
    beats.push({
      id: `b${i + 1}`,
      mediaKey: "",
      kind: "beat",
      text: t,
      date: "",
      headline: [],
      vo: t,
    });
  });

  return { beats, anh: ex.images.map((a) => a.url).slice(0, 8), tieuDe };
}

/** Cắt tiêu đề thành tối đa 2 dòng in hoa cho card mở đầu. */
function cheTieuDe(t: string): string[] {
  const hoa = t.toUpperCase();
  // ưu tiên tách ở dấu hai chấm hoặc gạch ngang — thường là ranh giới ý
  const tach = hoa.split(/\s*[:–—]\s*/).filter(Boolean);
  if (tach.length >= 2) return tach.slice(0, 2);

  const tu = hoa.split(/\s+/);
  if (tu.length < 7) return [hoa];
  const giua = Math.ceil(tu.length / 2);
  return [tu.slice(0, giua).join(" "), tu.slice(giua).join(" ")];
}

export { extractArticle };

// ───────────────────────────────────────────── đọc file sheet

export interface DongSheet {
  text: string;
  vo: string;
  anh: string;
}

/**
 * Đọc một bảng thành danh sách dòng {text, vo, anh}.
 *
 * Nhận diện cột theo TÊN ở hàng đầu (không phân biệt hoa thường, bỏ dấu) để
 * người dùng đặt tiêu đề cột bằng tiếng Việt hay tiếng Anh đều được. Không có
 * hàng tiêu đề thì coi cột 1 là chữ, cột 2 là ảnh.
 */
export function docBang(bang: string[][]): DongSheet[] {
  if (bang.length === 0) return [];

  const bo = (s: string) =>
    s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase().trim();

  const dau = bang[0].map(bo);
  const tim = (...ten: string[]) => dau.findIndex((c) => ten.some((t) => c.includes(t)));

  let iText = tim("text", "chu", "noi dung", "cau");
  let iVo = tim("vo", "giong", "doc", "loi binh");
  let iAnh = tim("anh", "image", "img", "hinh", "media", "url");

  let batDau = 1;
  if (iText < 0 && iAnh < 0) {
    // không có hàng tiêu đề -> đoán theo vị trí
    iText = 0;
    iAnh = bang[0].length > 1 ? 1 : -1;
    batDau = 0;
  }
  if (iText < 0) iText = 0;

  const ra: DongSheet[] = [];
  for (const h of bang.slice(batDau)) {
    const text = (h[iText] ?? "").trim();
    const anh = iAnh >= 0 ? (h[iAnh] ?? "").trim() : "";
    const vo = iVo >= 0 ? (h[iVo] ?? "").trim() : "";
    if (!text && !anh) continue;
    ra.push({ text, vo: vo || text, anh });
  }
  return ra;
}

/** Tách CSV/TSV có hỗ trợ ô bọc nháy kép và xuống dòng bên trong ô. */
export function tachCsv(noiDung: string): string[][] {
  const phanCach = noiDung.includes("\t") && !noiDung.includes(",") ? "\t" : ",";
  const bang: string[][] = [];
  let hang: string[] = [];
  let o = "";
  let trongNhay = false;

  for (let i = 0; i < noiDung.length; i++) {
    const c = noiDung[i];
    if (trongNhay) {
      if (c === '"') {
        if (noiDung[i + 1] === '"') { o += '"'; i++; }
        else trongNhay = false;
      } else o += c;
      continue;
    }
    if (c === '"') { trongNhay = true; continue; }
    if (c === phanCach) { hang.push(o); o = ""; continue; }
    if (c === "\n") { hang.push(o); bang.push(hang); hang = []; o = ""; continue; }
    if (c === "\r") continue;
    o += c;
  }
  if (o !== "" || hang.length) { hang.push(o); bang.push(hang); }
  return bang.filter((h) => h.some((x) => x.trim() !== ""));
}

/** Link Google Sheets -> link xuất CSV, để dán link cũng dùng được. */
export function linkSheetSangCsv(url: string): string | null {
  const m = url.match(/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  if (!m) return null;
  const gid = url.match(/[#&?]gid=(\d+)/)?.[1] ?? "0";
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}`;
}
