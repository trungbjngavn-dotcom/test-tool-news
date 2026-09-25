/**
 * URL bài báo -> bản nháp các nhịp (tiêu đề, ngày, đoạn văn, ảnh).
 *
 * Đây là TRÍCH XUẤT, không phải tóm tắt bằng AI: nó rút nội dung thật của bài
 * rồi điền sẵn vào giao diện để người dùng sửa. Không cần API key.
 * Repo gốc làm bước này bằng Claude Code skill (một agent đọc URL rồi viết
 * script.json tay) — cách đó không chạy được bên trong web app.
 */

import axios from "axios";
import * as cheerio from "cheerio";

export interface ExtractedImage {
  url: string;
  caption: string;
}

export interface Extracted {
  title: string;
  date: string;
  paragraphs: string[];
  images: ExtractedImage[];
  siteName: string;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

/** Rút ngày đăng: thử metadata chuẩn trước, rồi mới dò chuỗi dd/mm/yyyy trong trang. */
function findDate($: cheerio.CheerioAPI, html: string): string {
  const metaKeys = [
    'meta[property="article:published_time"]',
    'meta[itemprop="datePublished"]',
    'meta[name="pubdate"]',
    "time[datetime]",
  ];
  for (const sel of metaKeys) {
    const v = $(sel).attr("content") ?? $(sel).attr("datetime");
    if (v) {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) {
        return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
      }
    }
  }
  const m = html.match(/\b(\d{1,2})[/-](\d{1,2})[/-](20\d{2})\b/);
  return m ? `${Number(m[1])}/${Number(m[2])}/${m[3]}` : "";
}

/** Bỏ ảnh quảng cáo / icon / logo: giữ ảnh nằm trong thân bài và đủ lớn. */
function collectImages($: cheerio.CheerioAPI, base: string): ExtractedImage[] {
  const out: ExtractedImage[] = [];
  const seen = new Set<string>();

  $("figure, .article-content img, article img").each((_, el) => {
    const $el = $(el);
    const img = $el.is("img") ? $el : $el.find("img").first();
    const raw =
      img.attr("data-original") ?? img.attr("data-src") ?? img.attr("src") ?? "";
    if (!raw) return;

    let url: string;
    try {
      url = new URL(raw, base).toString();
    } catch {
      return;
    }
    // loại thumbnail nhỏ và logo
    if (/\/(zoom|thumb)\/(\d{1,3})[_x]/i.test(url)) return;
    if (/logo|avatar|icon|sprite|placeholder/i.test(url)) return;
    if (!/\.(jpe?g|png|webp)(\?|$)/i.test(url)) return;

    const key = url.replace(/^https?:\/\/[^/]+\//, "").split("/").pop() ?? url;
    if (seen.has(key)) return;
    seen.add(key);

    const cap = $el.is("figure")
      ? $el.find("figcaption").text().replace(/\s+/g, " ").trim()
      : (img.attr("alt") ?? "").trim();
    out.push({ url, caption: cap });
  });
  return out;
}

export async function extractArticle(pageUrl: string): Promise<Extracted> {
  const resp = await axios.get<string>(pageUrl, {
    headers: { "User-Agent": UA },
    timeout: 30000,
    responseType: "text",
  });
  const html = resp.data;
  const $ = cheerio.load(html);

  const title =
    $('meta[property="og:title"]').attr("content")?.trim() ||
    $("h1").first().text().trim() ||
    $("title").text().trim();

  const siteName =
    $('meta[property="og:site_name"]').attr("content")?.trim() ||
    new URL(pageUrl).hostname.replace(/^www\./, "");

  const sapo =
    $('meta[property="og:description"]').attr("content")?.trim() ||
    $('meta[name="description"]').attr("content")?.trim() ||
    "";

  // Ưu tiên vùng thân bài; nếu không nhận ra thì lấy mọi <p> đủ dài.
  const scopes = [".singular-content", ".article-content", "article", ".detail-content", "main"];
  let paras: string[] = [];
  for (const sc of scopes) {
    const found = $(sc)
      .find("p")
      .map((_, el) => $(el).text().replace(/\s+/g, " ").trim())
      .get()
      .filter((t) => t.length >= 60);
    if (found.length >= 3) {
      paras = found;
      break;
    }
  }
  if (paras.length === 0) {
    paras = $("p")
      .map((_, el) => $(el).text().replace(/\s+/g, " ").trim())
      .get()
      .filter((t) => t.length >= 60);
  }
  if (sapo && !paras.includes(sapo)) paras.unshift(sapo);

  // bỏ trùng lặp, giữ thứ tự
  const seen = new Set<string>();
  paras = paras.filter((p) => (seen.has(p) ? false : (seen.add(p), true)));

  return {
    title,
    date: findDate($, html),
    paragraphs: paras.slice(0, 20),
    images: collectImages($, pageUrl).slice(0, 12),
    siteName,
  };
}

/**
 * Cắt một đoạn văn dài thành câu ngắn vừa khung chữ (~140 ký tự).
 * Cắt theo ranh giới câu để không vỡ nghĩa.
 */
export function splitToBeatText(paragraph: string, maxLen = 140): string[] {
  const sentences = paragraph.split(/(?<=[.!?])\s+/);
  const out: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if (!buf) buf = s;
    else if ((buf + " " + s).length <= maxLen) buf += " " + s;
    else {
      out.push(buf);
      buf = s;
    }
  }
  if (buf) out.push(buf);
  return out.filter((t) => t.trim().length > 0);
}
