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

import { extractArticle, type Extracted } from "./extract.js";
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
 *
 * Một trang RSS chỉ trả ~11 bài và luôn cùng một thứ tự, bấm lại là y hệt. Nên
 * gom nhiều trang (`first=`) thành một rổ rồi bốc ngẫu nhiên — mỗi lần bấm ra
 * một mẻ khác.
 */
export async function layTinMoi(
  tuKhoa: string,
  soLuong = 10,
): Promise<{ items: TinTuc[]; cuaSoGio: number }> {
  /*
   * Hai kiểu truy vấn, gộp lại:
   *   - không lọc thời gian  -> đúng chủ đề gần như tuyệt đối, nhưng lẫn bài cũ
   *   - qft=interval + sortby -> tươi, nhưng Bing nới chủ đề rất rộng (đo thực
   *     tế chỉ 10/29 bài còn nhắc tới từ khoá)
   * Gộp rồi tự lọc thì được cả hai: vừa đúng chủ đề vừa mới.
   */
  const bienThe = ["", "&sortby=date&qft=interval%3d%227%22"];
  const trang = [1, 11, 21, 31];
  const yeuCau = bienThe.flatMap((b) => trang.map((f) => layMotTrang(tuKhoa, f, b).catch(() => [])));
  const meTin = await Promise.all(yeuCau);

  const theoUrl = new Map<string, TinTuc>();
  for (const me of meTin) {
    for (const t of me) if (!theoUrl.has(t.link)) theoUrl.set(t.link, t);
  }

  // Lọc đúng chủ đề — bắt buộc, không có ngoại lệ. Thà ít tin còn hơn đưa bài
  // chẳng liên quan gì.
  const tuKhoaChinh = tuChinh(tuKhoa);
  const ro = [...theoUrl.values()].filter((t) => hopChuDe(t, tuKhoaChinh));

  const gio = (t: TinTuc) => {
    const ms = Date.parse(t.pubDate);
    return Number.isFinite(ms) ? (Date.now() - ms) / 3_600_000 : Infinity;
  };
  let chon: TinTuc[] = [];
  let cuaSo = 0;
  for (const h of [24, 48, 24 * 7, 24 * 30]) {
    cuaSo = h;
    chon = ro.filter((t) => gio(t) <= h);
    if (chon.length >= soLuong) break;
  }
  if (chon.length === 0) chon = ro;

  for (let i = chon.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [chon[i], chon[j]] = [chon[j], chon[i]];
  }
  const ra = chon.slice(0, soLuong);
  ra.sort((a, b) => gio(a) - gio(b));
  return { items: ra, cuaSoGio: cuaSo };
}

/** Bỏ dấu để so khớp không phụ thuộc cách gõ. */
const boDau = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase();

/**
 * Những từ thực sự mang nghĩa trong câu tìm kiếm.
 *
 * "tin mới ielts" thì chỉ "ielts" mới đáng để lọc — mấy từ như "tin", "mới"
 * xuất hiện ở mọi bài báo nên lọc theo chúng là vô nghĩa.
 */
function tuChinh(tuKhoa: string): string[] {
  const bo = new Set([
    "tin", "moi", "nhat", "hom", "nay", "bai", "bao", "viet", "ve", "cua", "va",
    "the", "gioi", "trong", "ngay", "news", "latest", "today", "the",
  ]);
  return boDau(tuKhoa)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !bo.has(t));
}

/** Tiêu đề hoặc đường dẫn phải nhắc tới MỌI từ chính thì mới nhận. */
function hopChuDe(t: TinTuc, tuChinhList: string[]): boolean {
  if (tuChinhList.length === 0) return true;
  const noi = boDau(t.title + " " + t.link);
  return tuChinhList.every((tu) => noi.includes(tu));
}

/** Một trang kết quả RSS. `first` là vị trí bắt đầu, Bing đếm từ 1. */
async function layMotTrang(tuKhoa: string, first: number, bienThe = ""): Promise<TinTuc[]> {
  // qft=interval="7" + sortby=date là mấu chốt: mặc định Bing trộn cả bài cũ
  // hàng năm trời (đo thử: chỉ 2/12 bài trong 24 giờ), thêm hai tham số này thì
  // lên 23/30 bài trong 24 giờ.
  const url =
    "https://www.bing.com/news/search?q=" +
    encodeURIComponent(tuKhoa) +
    "&format=RSS&setmkt=vi-VN&setlang=vi" +
    bienThe +
    "&first=" +
    first;
  const { data } = await axios.get<string>(url, {
    timeout: 25000,
    headers: { "User-Agent": UA },
    responseType: "text",
  });

  const $ = cheerio.load(data, { xmlMode: true });
  const ra: TinTuc[] = [];
  $("item").each((_, el) => {
    const $e = $(el);
    const title = $e.find("title").text().trim();
    const boc = $e.find("link").text().trim();
    if (!title || !boc) return;

    const that = goLinkBing(boc);
    if (!that) return;

    let nguon = "";
    try { nguon = new URL(that).hostname.replace(/^www[.]/, ""); } catch { /* bỏ qua */ }
    if (!nguon || TRANG_BO_QUA.some((re) => re.test(nguon))) return;

    ra.push({ title, link: that, linkBoc: boc, source: nguon, pubDate: $e.find("pubDate").text().trim() });
  });
  return ra;
}

/**
 * Các trang chỉ đăng lại và dựng nội dung bằng JavaScript — tải HTML về chỉ
 * được cái khung rỗng, dựng ra dự án không có chữ nào. Loại khỏi danh sách cho
 * người dùng khỏi bấm trúng.
 */
const TRANG_BO_QUA = [/(^|[.])msn[.]com$/i, /(^|[.])news[.]google[.]com$/i, /(^|[.])baomoi[.]com$/i];

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

/** Độ dài tối đa một khối chữ trên màn hình, đo từ panel thật. */
const TOI_DA = 150;

/**
 * Chọn các câu TRỌN VẸN làm nhịp.
 *
 * Trước đây dùng chung bộ cắt của phần "dán văn bản": gặp câu dài là chẻ đôi ở
 * dấu phẩy, nên nhịp 1 hết nửa câu rồi nhịp 2 mới nói nốt — đọc rất cụt. Với
 * bài báo thì không cần cắt: bài nào cũng thừa câu, chỉ việc BỎ QUA câu quá dài
 * và lấy câu vừa khung.
 *
 * Chỉ khi bài quá ít câu ngắn mới đành rút gọn một câu dài, và rút ở ranh giới
 * mệnh đề để vẫn đọc ra một ý hoàn chỉnh.
 */
function chonCau(doan: string[], soCan: number): string[] {
  const tho = doan
    .flatMap((p) => p.split(/(?<=[.!?…])\s+/))
    .map((c) => c.trim())
    .filter((c) => c.length >= 40);

  // Bỏ câu trùng: báo hay lặp lại câu chốt ở sapo rồi nhắc lại trong thân bài,
  // để nguyên thì hai nhịp đọc y hệt nhau.
  const daCo = new Set<string>();
  const cau = tho.filter((c) => {
    const khoa = c.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (daCo.has(khoa)) return false;
    daCo.add(khoa);
    return true;
  });

  // Câu thật thì kết thúc bằng dấu câu. Không có dấu thường là tiêu đề phụ hoặc
  // chú thích ảnh — vẫn dùng được nhưng để dành, ưu tiên câu hoàn chỉnh trước.
  const tronVen = (c: string) => /[.!?…"”)]$/.test(c.trim());
  const vua = cau.filter((c) => c.length <= TOI_DA);
  const uuTien = [...vua.filter(tronVen), ...vua.filter((c) => !tronVen(c))];
  if (uuTien.length >= soCan) return uuTien.slice(0, soCan);

  // vẫn thiếu thì đành rút gọn câu dài
  const them: string[] = [];
  for (const c of cau) {
    if (them.length + uuTien.length >= soCan) break;
    if (c.length <= TOI_DA) continue;
    const rut = rutGon(c);
    if (rut && !daCo.has(rut.toLowerCase())) them.push(rut);
  }
  return [...uuTien, ...them].slice(0, soCan);
}

/** Rút một câu dài về trong khung, cắt ở ranh giới mệnh đề. */
function rutGon(cau: string): string | null {
  const cat = cau.slice(0, TOI_DA);
  const moc = Math.max(cat.lastIndexOf(", "), cat.lastIndexOf("; "), cat.lastIndexOf(" - "));
  if (moc < 60) return null; // cắt ngắn quá thì mất nghĩa, thà bỏ
  return cat.slice(0, moc).trim().replace(/[,;]$/, "") + ".";
}

/**
 * Biến một bài báo đã bóc tách thành kịch bản.
 *
 * Số nhịp theo độ dài bài: bài ngắn 3, vừa 4, dài 5 — cộng card mở đầu là 4–6
 * khối. Trước đây để tối đa 8 nên video lê thê và người dùng phải ngồi xoá bớt.
 */
export function kichBanTuBaiBao(ex: Extracted): KichBan {
  const tieuDe = (ex.title || "Bản tin").trim();
  const tongChu = ex.paragraphs.reduce((n, p) => n + p.length, 0);
  const soNhip = tongChu < 1200 ? 3 : tongChu < 2500 ? 4 : 5;

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

  chonCau(ex.paragraphs, soNhip).forEach((t, i) => {
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
