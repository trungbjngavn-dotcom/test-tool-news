/**
 * Sinh project HyperFrames cho template "newsroom".
 *
 * Kiến trúc (đã kiểm chứng bằng render thật):
 *   index.html          root: nền navy + bản đồ chìm (tĩnh) + mount các cảnh
 *                       + audio voiceover từng beat + clip outro
 *   compositions/scene-N.html   mỗi cảnh: 1 media (Ken Burns nếu là ảnh)
 *                               + các beat text dùng chung media đó
 *
 * Vì sao tách sub-composition thay vì một khối: `hyperframes lint` cảnh báo
 * `nested_structure_needs_subcomposition` khi root chứa phần tử timeline lồng nhau.
 */

import { mkdir, writeFile, readFile, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Project, Beat, Media } from "./types.js";
import { kenBurnsFor } from "./timeline.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(HERE, "assets");

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Số đo lấy từ video mẫu bằng cách đo pixel, không phải ước lượng.
const LAYOUT = {
  shotHeight: 1072,
  maskSolidTo: 847, // ảnh còn đặc tới đây
  maskFadeTo: 1067, // rồi tan hẳn vào navy
  beatTop: 1070,
  beatHeight: 540,
  beatPadX: 132,
  titleTop: 1085,
  titlePadLeft: 69,
};

function sceneCss(p: Project, isTitle: boolean): string {
  const b = p.brand;
  let css = `        #root {
          position: absolute; inset: 0; overflow: hidden;
          font-family: Montserrat, sans-serif; -webkit-font-smoothing: antialiased;
        }
        /* nửa trên: media, hoà dần xuống nền navy */
        .shot {
          position: absolute; left: 0; top: 0; width: ${p.width}px; height: ${LAYOUT.shotHeight}px;
          overflow: hidden;
          -webkit-mask-image: linear-gradient(to bottom, #000 0px, #000 ${LAYOUT.maskSolidTo}px, rgba(0,0,0,0) ${LAYOUT.maskFadeTo}px);
          mask-image: linear-gradient(to bottom, #000 0px, #000 ${LAYOUT.maskSolidTo}px, rgba(0,0,0,0) ${LAYOUT.maskFadeTo}px);
        }
        .kb { position: absolute; inset: 0; will-change: transform; }
        .kb img, .shot > video {
          width: 100%; height: 100%; object-fit: cover; display: block;
        }
        .shot > video { position: absolute; inset: 0; }

        /* nửa dưới: khối chữ */
        .beat {
          position: absolute; left: 0; top: ${LAYOUT.beatTop}px; width: ${p.width}px;
          height: ${LAYOUT.beatHeight}px;
          display: flex; align-items: center; justify-content: center;
          padding: 0 ${LAYOUT.beatPadX}px; box-sizing: border-box;
          flex-direction: column; will-change: transform, opacity;
        }
        .btext {
          margin: 0; font-size: 52px; line-height: 1.42; font-weight: 700;
          color: #fff; text-align: center; letter-spacing: 0.1px;
        }
        .bsrc {
          margin: 30px 0 0; font-size: 33px; font-weight: 600; font-style: italic;
          color: #C6D0EA; text-align: center;
        }`;

  if (isTitle) {
    css += `
        /* card mở đầu */
        .beat--title {
          top: ${LAYOUT.titleTop}px; height: 420px;
          align-items: flex-start; justify-content: flex-start;
          padding: 0 88px 0 ${LAYOUT.titlePadLeft}px;
        }
        .datepill {
          background: #fff; color: #1B2A5E; font-size: 31px; font-weight: 800;
          font-style: italic; padding: 13px 18px;
        }
        .headwrap { display: flex; align-items: stretch; gap: 30px; margin-top: 44px; }
        .headbar { width: 9px; background: #fff; transform-origin: 50% 0%; will-change: transform; }
        .hline { font-size: 50px; font-weight: 800; line-height: 1.28; color: #fff; letter-spacing: 0.2px; }

        /* badge thương hiệu. Nằm sát mép trái nên transform-origin phải ở cạnh
           trái — để mặc định giữa thì lúc scale-in sẽ hở một khoảng bên trái. */
        #badge {
          position: absolute; left: ${b.badgeLeft}px; top: ${b.badgeTop}px;
          width: ${b.badgeWidth}px; height: ${b.badgeHeight}px;
          display: block; transform-origin: 0% 50%; will-change: transform, opacity;
        }`;
  }
  return css;
}

function beatInner(p: Project, b: Beat): string {
  if (b.kind === "title") {
    const lines = b.headline.map((l) => `              <div class="hline">${esc(l)}</div>`).join("\n");
    const datePill = b.date ? `          <div class="datepill">NGÀY ĐĂNG: ${esc(b.date)}</div>\n` : "";
    return (
      datePill +
      `          <div class="headwrap">\n` +
      `            <div class="headbar" id="${b.id}-bar"></div>\n` +
      `            <div>\n${lines}\n            </div>\n          </div>`
    );
  }
  return (
    `          <p class="btext">${esc(b.text)}</p>\n` +
    `          <p class="bsrc">${esc(p.brand.sourceLabel)}</p>`
  );
}

function sceneFile(p: Project, idx: number, shotBeats: Beat[], media: Media, shotStart: number, shotDur: number) {
  const cid = `scene-${idx}`;
  const isTitle = shotBeats[0].kind === "title";
  const body: string[] = [];
  const tl: string[] = [];

  if (media.kind === "video") {
    // <video> phải muted; tiếng (nếu dùng) đi bằng <audio> riêng ở root.
    // Không bọc trong phần tử cũng mang data-start (lint: video_nested_in_timed_element).
    const ms = media.mediaStartSec > 0 ? ` data-media-start="${media.mediaStartSec}"` : "";
    body.push(
      `        <div class="shot"><video id="${cid}-video" src="${esc(media.src)}" data-start="0" ` +
        `data-duration="${shotDur}"${ms} style="object-position: ${esc(media.position)}" ` +
        `muted playsinline></video></div>`,
    );
  } else {
    body.push(
      `        <div class="shot"><div class="kb" id="${cid}-kb" data-layout-allow-overflow>` +
        `<img src="${esc(media.src)}" alt="" style="object-position: ${esc(media.position)}" /></div></div>`,
    );
    const kb = kenBurnsFor(idx);
    tl.push(
      `          tl.fromTo("#${cid}-kb", { scale: ${kb.from}, x: ${kb.xFrom} }, ` +
        `{ scale: ${kb.to}, x: ${kb.xTo}, duration: ${shotDur}, ease: "none" }, 0);`,
    );
  }

  for (const b of shotBeats) {
    const ls = Math.round((((b.startSec as number) - shotStart) + Number.EPSILON) * 1000) / 1000;
    const cls = b.kind === "title" ? "beat beat--title clip" : "beat clip";
    body.push(
      `        <div class="${cls}" id="${b.id}" data-start="${ls}" ` +
        `data-duration="${b.durationSec}" data-track-index="1">\n${beatInner(p, b)}\n        </div>`,
    );
    tl.push(
      `          tl.fromTo("#${b.id}", { y: 26, opacity: 0 }, ` +
        `{ y: 0, opacity: 1, duration: 0.42, ease: "power3.out" }, ${ls});`,
    );
    const outAt = Math.round(((ls + (b.durationSec as number) - 0.18) + Number.EPSILON) * 1000) / 1000;
    tl.push(`          tl.to("#${b.id}", { opacity: 0, duration: 0.18, ease: "power2.in" }, ${outAt});`);
    if (b.kind === "title") {
      tl.push(
        `          tl.fromTo("#${b.id}-bar", { scaleY: 0 }, ` +
          `{ scaleY: 1, duration: 0.45, ease: "power3.out" }, ${Math.round((ls + 0.12) * 1000) / 1000});`,
      );
    }
  }

  if (isTitle && p.brand.badgeSrc) {
    body.push(`        <img id="badge" src="${esc(p.brand.badgeSrc)}" alt="${esc(p.title)}" />`);
    tl.push(
      `          tl.fromTo("#badge", { scaleX: 0.55, scaleY: 0.86, opacity: 0 }, ` +
        `{ scaleX: 1, scaleY: 1, opacity: 1, duration: 0.52, ease: "back.out(1.8)" }, 0.05);`,
    );
    tl.push(
      `          tl.to("#badge", { opacity: 0, duration: 0.2, ease: "power2.in" }, ` +
        `${Math.round((shotDur - 0.2) * 1000) / 1000});`,
    );
  }

  const html = `<!doctype html>
<html lang="vi">
  <head><meta charset="UTF-8" /></head>
  <body>
    <template>
      <style>
${sceneCss(p, isTitle)}
      </style>

      <div id="root" data-composition-id="${cid}" data-width="${p.width}" data-height="${p.height}">
${body.join("\n")}
      </div>

      <script>
        (function () {
          const tl = gsap.timeline({ paused: true });
${tl.join("\n")}
          window.__timelines["${cid}"] = tl;
        })();
      </script>
    </template>
  </body>
</html>
`;

  const host =
    `      <div id="${cid}-host" data-composition-id="${cid}" ` +
    `data-composition-src="compositions/${cid}.html"\n` +
    `           data-start="${shotStart}" data-duration="${shotDur}" ` +
    `data-track-index="${idx + 1}" data-width="${p.width}" data-height="${p.height}"></div>`;

  return { cid, html, host };
}

export interface ComposeArgs {
  project: Project;
  /** Thư mục dự án HyperFrames sẽ được ghi vào. */
  outDir: string;
  /** Đường dẫn file audio voiceover của từng beat, tương đối so với outDir. */
  voicePaths: Record<string, string>;
}

export async function composeNewsroom({ project: p, outDir, voicePaths }: ComposeArgs): Promise<void> {
  if (!p.shots || typeof p.totalSec !== "number") {
    throw new Error("Project chưa có timeline — gọi computeTimeline() trước.");
  }
  const beatById = new Map(p.beats.map((b) => [b.id, b]));
  await mkdir(path.join(outDir, "compositions"), { recursive: true });
  await mkdir(path.join(outDir, "assets", "brand"), { recursive: true });

  // bản đồ thế giới bake sẵn (không fetch lúc render — luật determinism)
  const worldSvg = await readFile(path.join(ASSETS, "world.svg"), "utf8");
  const badgeOut = path.join(outDir, p.brand.badgeSrc);
  if (!existsSync(badgeOut)) {
    const bundled = path.join(ASSETS, "badge.png");
    if (existsSync(bundled)) {
      await mkdir(path.dirname(badgeOut), { recursive: true });
      await copyFile(bundled, badgeOut);
    }
  }

  const hosts: string[] = [];
  for (let i = 0; i < p.shots.length; i++) {
    const s = p.shots[i];
    const media = p.media[s.mediaKey];
    if (!media) throw new Error(`Beat trỏ tới media không tồn tại: "${s.mediaKey}"`);
    const beats = s.beatIds.map((id) => beatById.get(id)!).filter(Boolean);
    const { cid, html, host } = sceneFile(p, i, beats, media, s.startSec, s.durationSec);
    await writeFile(path.join(outDir, "compositions", `${cid}.html`), html, "utf8");
    hosts.push(host);
  }

  // Voiceover đặt ở root theo thời gian tuyệt đối, mỗi beat một track riêng —
  // nếu để chung track, linter báo chồng lấn vì nó so thời gian cục bộ giữa các file.
  const audio: string[] = p.beats.map(
    (b, i) =>
      `      <audio id="vo-${b.id}" src="${esc(voicePaths[b.id])}" data-start="${b.startSec}" ` +
      `data-duration="${b.voDurationSec}" data-track-index="${20 + i}" data-volume="1"></audio>`,
  );

  if (p.outro.src && p.outro.durationSec > 0) {
    hosts.push(
      `      <video id="outro-video" class="clip outro" src="${esc(p.outro.src)}"\n` +
        `             data-start="${p.outro.startSec}" data-duration="${p.outro.durationSec}"\n` +
        `             data-track-index="${p.shots.length + 1}" muted playsinline></video>`,
    );
    audio.push(
      `      <audio id="outro-audio" src="${esc(p.outro.src)}" data-start="${p.outro.startSec}" ` +
        `data-duration="${p.outro.durationSec}" data-track-index="${20 + p.beats.length}" ` +
        `data-volume="1"></audio>`,
    );
  }

  // media video có tiếng gốc -> thêm audio track riêng (video luôn muted)
  let extra = 21 + p.beats.length;
  for (const s of p.shots) {
    const m = p.media[s.mediaKey];
    if (m?.kind === "video" && m.useSourceAudio) {
      audio.push(
        `      <audio id="src-${s.mediaKey}-${s.startSec}" src="${esc(m.src)}" ` +
          `data-start="${s.startSec}" data-duration="${s.durationSec}" ` +
          `data-track-index="${extra++}" data-volume="0.35"></audio>`,
      );
    }
  }

  const index = `<!doctype html>
<html lang="vi">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${p.width}, height=${p.height}" />
    <title>${esc(p.title)}</title>
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      body { margin: 0; background: ${p.brand.navy}; }
      #root {
        position: relative; width: 100%; height: 100%;
        overflow: hidden; background: ${p.brand.navy};
        font-family: Montserrat, sans-serif; -webkit-font-smoothing: antialiased;
      }
      /* nền cố định, không nằm trên timeline */
      #stage { position: absolute; inset: 0; background: ${p.brand.navy}; }
      #map {
        position: absolute; left: -764px; top: 1116px; width: 2016px; height: 1008px;
        color: ${p.brand.mapColor}; pointer-events: none;
      }
      #map svg { width: 100%; height: 100%; display: block; }
      .outro {
        position: absolute; inset: 0; width: 100%; height: 100%;
        object-fit: cover; z-index: 5;
      }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0"
         data-width="${p.width}" data-height="${p.height}" data-duration="${p.totalSec}">

      <div id="stage">
        <div id="map">${worldSvg}</div>
      </div>

${hosts.join("\n")}

${audio.join("\n")}
    </div>

    <script>
      window.__timelines["main"] = gsap.timeline({ paused: true });
    </script>
  </body>
</html>
`;
  await writeFile(path.join(outDir, "index.html"), index, "utf8");

  await writeFile(
    path.join(outDir, "hyperframes.json"),
    JSON.stringify(
      {
        $schema: "https://hyperframes.heygen.com/schema/hyperframes.json",
        paths: { blocks: "compositions", components: "compositions/components", assets: "assets" },
        media: { autoProxy: true },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  await writeFile(
    path.join(outDir, "meta.json"),
    JSON.stringify({ id: "newsroom", name: p.title }, null, 2) + "\n",
    "utf8",
  );
}
