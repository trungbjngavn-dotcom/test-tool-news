/* ═══════════════════════════════════════════════════════════════════════
   Tool News — giao diện (vanilla JS, không build step)
   ═══════════════════════════════════════════════════════════════════════ */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

function el(tag, cls, txt) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
}

/** Đường vẽ icon dùng lại nhiều chỗ. */
const ICON = {
  trash: "M4 7h16M9 7V5.5A1.5 1.5 0 0110.5 4h3A1.5 1.5 0 0115 5.5V7m-9 0l.8 12A1.5 1.5 0 008.3 20h7.4a1.5 1.5 0 001.5-1.4L18 7",
  up: "M12 19V5m0 0l-6 6m6-6l6 6",
  down: "M12 5v14m0 0l6-6m-6 6l-6-6",
  copy: "M9 9h10v10H9zM5 15V5h10",
  grip: "M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01",
  folder: "M3 7.5A1.5 1.5 0 014.5 6h4l2 2.5h9A1.5 1.5 0 0121 10v8a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 18z",
  file: "M14 3H7.5A1.5 1.5 0 006 4.5v15A1.5 1.5 0 007.5 21h9a1.5 1.5 0 001.5-1.5V7zM14 3v4h4",
  x: "M6 6l12 12M18 6L6 18",
  plus: "M12 5v14M5 12h14",
};

function icon(d) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", d);
  svg.append(p);
  return svg;
}

/** Textarea tự cao theo nội dung — bớt khoảng trống thừa trên thẻ nhịp. */
function autoGrow(ta, minRows = 2) {
  ta.rows = minRows;
  ta.classList.add("auto");
  const fit = () => {
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  };
  ta.addEventListener("input", fit);
  requestAnimationFrame(fit);
  ta.fit = fit;
  return ta;
}

/**
 * Gắn sự kiện an toàn. Nếu markup và script lệch nhau (ví dụ trình duyệt còn giữ
 * bản app.js cũ trong cache) thì chỉ phần tử đó mất tác dụng, chứ không ném lỗi
 * làm chết luôn mọi binding phía sau.
 */
function on(sel, type, fn) {
  const n = typeof sel === "string" ? $(sel) : sel;
  if (!n) {
    console.warn("[Tool News] không tìm thấy phần tử:", sel);
    return null;
  }
  n.addEventListener(type, fn);
  return n;
}

const api = async (url, opts = {}) => {
  // Chỉ khai application/json khi THỰC SỰ có body JSON. Khai kèm body rỗng thì
  // Fastify trả lỗi "Body cannot be empty when content-type is set to
  // 'application/json'" — đúng trường hợp các nút chạy job (POST không body).
  // FormData tự mang boundary riêng nên cũng không được đặt tay.
  const isJson = opts.body != null && !(opts.body instanceof FormData);
  const r = await fetch(url, {
    ...opts,
    headers: isJson ? { "Content-Type": "application/json" } : undefined,
  });
  if (!r.ok) throw new Error((await r.text()).slice(0, 400));
  return r.json();
};

// ───────────────────────────────────────────── nền sáng / tối

/* Mặc định sáng. Người dùng chọn tối thì nhớ lại cho lần sau. localStorage có
   thể ném lỗi (chế độ ẩn danh, chặn cookie) nên bọc try/catch. */
const THEME_KEY = "tool-news-theme";

function applyTheme(mode) {
  if (mode === "dark") document.documentElement.setAttribute("data-theme", "dark");
  else document.documentElement.removeAttribute("data-theme");
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    /* không lưu được thì thôi, trong phiên vẫn đúng */
  }
}

function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch {
    /* bỏ qua */
  }
  applyTheme(saved === "dark" ? "dark" : "light");
}
initTheme();

// ───────────────────────────────────────────── thông báo nổi

function toast(msg, kind = "") {
  const t = el("div", "toast " + kind, msg);
  $("#toasts").append(t);
  setTimeout(() => {
    t.classList.add("out");
    t.addEventListener("animationend", () => t.remove(), { once: true });
  }, kind === "err" ? 7000 : 3200);
}
const fail = (e) => toast(typeof e === "string" ? e : e.message, "err");

// ───────────────────────────────────────────── trạng thái

const state = {
  id: null,
  project: null,
  projects: [],
  /** khoá media → {kind, thumb}; chỉ phục vụ giao diện, không ghi vào project.json */
  mediaMeta: {},
  /** đổi mỗi khi file trên đĩa thay đổi, để phá cache ảnh */
  stamp: 0,
  saveTimer: null,
};

const fileUrl = (rel) => `/api/projects/${state.id}/file/${rel}?t=${state.stamp}`;

/* Nửa trên khung hình là 1080×1072 (gần vuông) và ảnh được phủ kín theo kiểu
   object-fit: cover, cộng thêm Ken Burns phóng nhẹ 1.06 lần ngay từ đầu. Vậy hệ
   số phóng thực tế = max(1145/rộng, 1136/cao). Dưới 1.6 lần thì mắt thường gần
   như không thấy, nên chỉ cảnh báo từ mức đó trở lên — tránh báo động giả. */
const FIT_W = 1145, FIT_H = 1136, MAX_UPSCALE = 1.6;

/** Ảnh phải phóng lên bao nhiêu lần để phủ kín nửa trên. */
function upscaleOf(m) {
  if (m.kind !== "image" || !m.width || !m.height) return 0;
  return Math.max(FIT_W / m.width, FIT_H / m.height);
}
const isLowRes = (m) => upscaleOf(m) > MAX_UPSCALE;

/** Đánh dấu có thay đổi → tự lưu sau 700ms im lặng. */
function touch() {
  setSaveState("saving", "Đang lưu…");
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => saveProject().catch(fail), 700);
}

function setSaveState(cls, txt) {
  const n = $("#saveState");
  n.className = "savestate " + cls;
  n.textContent = txt || " ";
}

async function saveProject() {
  if (!state.id) return;
  clearTimeout(state.saveTimer);
  await api(`/api/projects/${state.id}`, { method: "PUT", body: JSON.stringify(state.project) });
  setSaveState("saved", "Đã lưu");
  setTimeout(() => {
    if ($("#saveState").classList.contains("saved")) setSaveState("", "");
  }, 2200);
}

// ───────────────────────────────────────────── dự án

async function refreshProjects(selectId) {
  state.projects = await api("/api/projects");
  $("#app").hidden = state.projects.length === 0;
  $("#empty").hidden = state.projects.length > 0;
  if (!state.projects.length) {
    state.id = null;
    $("#projBtnName").textContent = "—";
    renderProjMenu();
    return;
  }
  const pick = selectId && state.projects.some((p) => p.id === selectId) ? selectId : state.projects[0].id;
  await openProject(pick);
}

function renderProjMenu() {
  const m = $("#projMenu");
  m.innerHTML = "";
  for (const p of state.projects) {
    const b = el("button", p.id === state.id ? "on" : "");
    b.append(el("span", null, p.title), el("small", null, `${p.beats} nhịp`));
    b.onclick = () => { closeProjMenu(); if (p.id !== state.id) openProject(p.id).catch(fail); };
    m.append(b);
  }
  m.append(el("div", "sep"));
  const nb = el("button", null, "+  Dự án mới");
  nb.onclick = () => { closeProjMenu(); askNewProject(); };
  m.append(nb);
  if (state.id) {
    const db = el("button", "danger", "Xoá dự án này");
    db.onclick = () => { closeProjMenu(); deleteProject().catch(fail); };
    m.append(db);
  }
}

function closeProjMenu() {
  $("#projMenu").hidden = true;
  $("#projBtn").setAttribute("aria-expanded", "false");
}

async function openProject(id) {
  const { project } = await api(`/api/projects/${id}`);
  state.id = id;
  state.project = project;
  state.stamp = Date.now();
  state.mediaMeta = {};
  for (const [key, m] of Object.entries(project.media ?? {})) {
    state.mediaMeta[key] = { kind: m.kind, thumb: `assets/media/${key}-thumb.jpg` };
  }
  $("#projBtnName").textContent = project.title;
  renderProjMenu();
  setSaveState("", "");
  renderAll();
}

async function deleteProject() {
  if (!confirm(`Xoá hẳn dự án “${state.project.title}” cùng toàn bộ file của nó?`)) return;
  await api(`/api/projects/${state.id}`, { method: "DELETE" });
  state.id = null;
  await refreshProjects();
  toast("Đã xoá dự án.");
}

function askNewProject() {
  $("#newTitle").value = "Bản tin " + new Date().toLocaleDateString("vi-VN");
  $("#newDlg").showModal();
  $("#newTitle").select();
}

// ───────────────────────────────────────────── thư viện media

function renderMedia() {
  const grid = $("#mediaGrid");
  grid.innerHTML = "";
  const entries = Object.entries(state.project.media ?? {});
  $("#mediaCount").textContent = String(entries.length);

  // Trống thì mời kéo thả; có rồi thì ô "+" cuối lưới là đủ, khỏi chiếm chỗ.
  $("#dropzone").hidden = entries.length > 0;

  for (const [key, m] of entries) {
    const item = el("div", "media-item");
    item.draggable = true;
    item.dataset.key = key;
    item.title = "Kéo thả vào một nhịp để dùng";

    const img = el("img");
    img.src = fileUrl(`assets/media/${key}-thumb.jpg`);
    img.alt = "";
    // <img> mặc định tự kéo được: nắm vào ảnh là trình duyệt kéo CHÍNH tấm ảnh
    // thay vì cả ô, nên dữ liệu media-key không đi theo. Tắt đi.
    img.draggable = false;
    img.onerror = () => img.remove();
    const tag = el("span", "tag" + (m.kind === "video" ? " is-video" : ""),
      m.kind === "video" ? "VIDEO" : "ẢNH");
    item.append(img, tag);

    if (isLowRes(m)) {
      item.classList.add("is-lowres");
      const w = el("span", "warn-dot", "!");
      w.title = `Ảnh ${m.width}×${m.height}px, phải phóng ${upscaleOf(m).toFixed(1)} lần ` +
        "để phủ kín nửa trên khung hình — lên video sẽ vỡ hạt.";
      item.append(w);
    }

    const del = el("button", "del");
    del.append(icon(ICON.x));
    del.title = "Xoá khỏi thư viện";
    del.onclick = (e) => {
      e.stopPropagation();
      const used = state.project.beats.filter((b) => b.mediaKey === key).length;
      if (used && !confirm(`${used} nhịp đang dùng media này. Vẫn xoá?`)) return;
      delete state.project.media[key];
      for (const b of state.project.beats) if (b.mediaKey === key) b.mediaKey = "";
      renderAll(); touch();
    };
    item.append(del);

    item.ondragstart = (e) => {
      e.dataTransfer.setData("text/media-key", key);
      e.dataTransfer.effectAllowed = "copy";
    };
    grid.append(item);
  }

  if (entries.length) {
    const add = el("div", "media-add");
    add.append(icon(ICON.plus), el("span", null, "Thêm"));
    add.title = "Chọn thêm file, hoặc kéo thả vào đây";
    add.onclick = () => $("#fileInput").click();
    add.ondragover = (e) => { if (hasFiles(e)) { e.preventDefault(); add.classList.add("hot"); } };
    add.ondragleave = () => add.classList.remove("hot");
    add.ondrop = () => add.classList.remove("hot");
    grid.append(add);
  }
}

async function addFiles(files) {
  if (!files.length) return;
  const fd = new FormData();
  for (const f of files) fd.append("files", f);
  toast(`Đang nạp ${files.length} file…`);
  const { added } = await api(`/api/projects/${state.id}/media`, { method: "POST", body: fd });
  applyAdded(added);
}

function applyAdded(added) {
  let ok = 0;
  for (const a of added) {
    if (a.error) { fail(a.error); continue; }
    state.project.media[a.key] = {
      src: a.src, kind: a.kind, position: "50% 50%", mediaStartSec: 0, useSourceAudio: false,
    };
    state.mediaMeta[a.key] = a;
    ok++;
    // nhịp nào chưa có media thì gán luôn cái vừa thêm
    const orphan = state.project.beats.find((b) => !b.mediaKey);
    if (orphan) orphan.mediaKey = a.key;
  }
  state.stamp = Date.now();
  renderAll();
  touch();
  if (ok) toast(`Đã thêm ${ok} media.`, "ok");

  const small = added.filter(
    (a) => !a.error && a.size && isLowRes({ kind: a.kind, width: a.size.width, height: a.size.height }),
  );
  if (small.length) {
    const worst = small.reduce((x, y) => (y.size.width < x.size.width ? y : x));
    toast(
      `${small.length} ảnh quá nhỏ so với khung hình (nhỏ nhất ${worst.size.width}×${worst.size.height}px) — ` +
      "lên video sẽ vỡ hạt. Nên lấy bản gốc độ phân giải cao hơn.",
      "err",
    );
  }
}

// ───────────────────────────────────────────── kịch bản

function nextBeatId() {
  const used = new Set(state.project.beats.map((b) => b.id));
  let n = 1;
  while (used.has("b" + n)) n++;
  return "b" + n;
}

function newBeat(text = "") {
  const beats = state.project.beats;
  return {
    id: nextBeatId(),
    mediaKey: beats.at(-1)?.mediaKey ?? Object.keys(state.project.media ?? {})[0] ?? "",
    kind: "beat",
    text,
    date: "",
    headline: [],
    vo: text,
  };
}

function renderBeats() {
  const list = $("#beatList");
  list.innerHTML = "";
  const beats = state.project.beats;

  if (!beats.length) {
    const box = el("div", "card card--static");
    const body = el("div", "card-body");
    body.style.padding = "30px 18px";
    body.append(el("p", "note", "Chưa có nhịp nào. Bấm “Dán văn bản” để tách nhanh cả bài, hoặc “+ Thêm nhịp”."));
    box.append(body);
    list.append(box);
    return;
  }

  beats.forEach((b, i) => {
    const prev = i > 0 ? beats[i - 1] : null;
    const chained = prev && b.mediaKey && prev.mediaKey === b.mediaKey;

    const card = el("div", "beat" + (b.kind === "title" ? " is-title" : ""));

    // ── đầu thẻ ──────────────────────────────────────
    const head = el("div", "beat-head");

    const grip = el("div", "beat-grip");
    grip.append(icon(ICON.grip));
    grip.title = "Kéo để đổi thứ tự";
    grip.draggable = true;
    grip.ondragstart = (e) => {
      e.dataTransfer.setData("text/beat-index", String(i));
      e.dataTransfer.effectAllowed = "move";
      card.classList.add("dragging");
    };
    grip.ondragend = () => card.classList.remove("dragging");
    head.append(grip, el("span", "beat-no", String(i + 1)));

    const kindSel = el("select");
    for (const [v, t] of [["beat", "Khối chữ"], ["title", "Card mở đầu"]]) {
      const o = el("option", null, t);
      o.value = v;
      kindSel.append(o);
    }
    kindSel.value = b.kind;
    kindSel.onchange = () => { b.kind = kindSel.value; renderBeats(); touch(); };
    head.append(kindSel);

    if (chained) {
      const tag = el("span", "tagline", "↳ nối cảnh trên");
      tag.title = "Dùng chung media với nhịp trước nên hình chạy liên tục, không giật lại";
      head.append(tag);
    }
    head.append(el("div", "spacer"));

    const iconBtn = (d, title, fn, danger) => {
      const bt = el("button", "btn btn--icon" + (danger ? " danger" : ""));
      bt.append(icon(d));
      bt.title = title;
      bt.onclick = fn;
      return bt;
    };
    head.append(
      iconBtn(ICON.up, "Lên", () => {
        if (!i) return;
        [beats[i - 1], beats[i]] = [beats[i], beats[i - 1]];
        renderBeats(); touch();
      }),
      iconBtn(ICON.down, "Xuống", () => {
        if (i === beats.length - 1) return;
        [beats[i + 1], beats[i]] = [beats[i], beats[i + 1]];
        renderBeats(); touch();
      }),
      iconBtn(ICON.copy, "Nhân đôi", () => {
        const clone = structuredClone(b);
        clone.id = nextBeatId();
        delete clone.voDurationSec;
        delete clone.startSec;
        beats.splice(i + 1, 0, clone);
        renderBeats(); touch();
      }),
      iconBtn(ICON.trash, "Xoá nhịp", () => {
        beats.splice(i, 1);
        renderBeats(); touch();
      }, true),
    );
    card.append(head);

    // Thẻ nhận hai loại thả: nhịp khác (đổi thứ tự) và media (gán hình).
    // Cho cả thẻ nhận media chứ không chỉ ô hình 104px — nhắm vào ô nhỏ đó khó.
    card.ondragover = (e) => {
      const types = [...e.dataTransfer.types];
      if (types.includes("text/beat-index")) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        card.classList.add("drag-over");
      } else if (types.includes("text/media-key")) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        card.classList.add("drag-over");
      }
    };
    card.ondragleave = () => card.classList.remove("drag-over");
    card.ondrop = (e) => {
      card.classList.remove("drag-over");

      const mediaKey = e.dataTransfer.getData("text/media-key");
      if (mediaKey) {
        e.preventDefault();
        b.mediaKey = mediaKey;
        renderBeats(); touch();
        return;
      }

      const from = e.dataTransfer.getData("text/beat-index");
      if (from === "") return;
      e.preventDefault();
      const f = Number(from);
      if (f === i) return;
      const [moved] = beats.splice(f, 1);
      beats.splice(i, 0, moved);
      renderBeats(); touch();
    };

    // ── thân thẻ ─────────────────────────────────────
    const body = el("div", "beat-body");

    const meta = state.mediaMeta[b.mediaKey];
    const thumb = el("div", "beat-thumb" + (meta ? " has-media" : ""));
    if (meta) {
      const img = el("img");
      img.src = fileUrl(meta.thumb ?? `assets/media/${b.mediaKey}-thumb.jpg`);
      img.alt = "";
      img.onerror = () => {
        thumb.classList.remove("has-media");
        thumb.textContent = "không đọc được ảnh";
      };
      thumb.append(img, el("span", "kindtag", meta.kind === "video" ? "VIDEO" : "ẢNH"));
    } else {
      thumb.textContent = "Kéo media vào đây";
    }
    thumb.title = "Kéo media từ thư viện thả vào, hoặc bấm để đổi sang media kế tiếp";
    thumb.onclick = () => cycleMedia(b);
    // Nguồn kéo đặt effectAllowed="copy"; nếu đích không đặt dropEffect khớp
    // thì Chrome tự quy về "none" và KHÔNG bắn sự kiện drop.
    thumb.ondragover = (e) => {
      if (!keoMedia(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      thumb.classList.add("drag-over");
    };
    thumb.ondragleave = () => thumb.classList.remove("drag-over");
    thumb.ondrop = (e) => {
      e.preventDefault();
      e.stopPropagation();
      thumb.classList.remove("drag-over");
      const key = e.dataTransfer.getData("text/media-key");
      if (key) { b.mediaKey = key; renderBeats(); touch(); }
    };
    body.append(thumb);

    const fields = el("div", "beat-fields");
    const sync = el("input");
    sync.type = "checkbox";

    let textArea = null;
    if (b.kind === "title") {
      const d = el("input");
      d.type = "text";
      d.placeholder = "Ngày, ví dụ 25/9/2026";
      d.value = b.date ?? "";
      d.className = "f-date";
      d.oninput = () => { b.date = d.value; touch(); };
      fields.append(el("div", "sub-label d-date", "Ngày"), d);

      const h = autoGrow(el("textarea"), 2);
      h.placeholder = "Mỗi dòng ở đây là một dòng tiêu đề trên màn hình";
      h.value = (b.headline ?? []).join("\n");
      h.oninput = () => { b.headline = h.value.split("\n").filter((x) => x.trim()); touch(); };
      h.className = "auto f-title";
      fields.append(el("div", "sub-label d-title", "Tiêu đề"), h);
    } else {
      textArea = autoGrow(el("textarea"), 2);
      textArea.placeholder = "Chữ hiện trên màn hình…";
      textArea.value = b.text ?? "";
      textArea.classList.add("f-text");
      fields.append(el("div", "sub-label d-text", "Chữ hiển thị"), textArea);
    }

    const vo = autoGrow(el("textarea"), 2);
    vo.placeholder = "Câu đọc — nên viết số ra chữ, ví dụ 26/9 → hai mươi sáu tháng chín";
    vo.value = b.vo ?? "";
    vo.oninput = () => {
      b.vo = vo.value;
      delete b.voDurationSec;
      touch();
    };
    vo.classList.add("f-vo");
    const voLabel = el("div", "sub-label d-vo", "Giọng đọc");
    fields.append(voLabel, vo);

    if (textArea) {
      sync.checked = (b.text ?? "") === (b.vo ?? "");
      // Trùng nhau thì giấu ô giọng đọc đi cho thẻ gọn; bỏ tick là hiện lại.
      const syncView = () => {
        voLabel.hidden = sync.checked;
        vo.hidden = sync.checked;
        if (!sync.checked) vo.fit();
      };
      syncView();
      textArea.oninput = () => {
        b.text = textArea.value;
        if (sync.checked) {
          b.vo = textArea.value;
          vo.value = textArea.value;
          delete b.voDurationSec;
        }
        touch();
      };
      sync.onchange = () => {
        if (sync.checked) {
          b.vo = b.text ?? "";
          vo.value = b.vo;
          delete b.voDurationSec;
          touch();
        }
        syncView();
      };
    }

    const foot = el("div", "beat-foot");
    if (textArea) {
      const lb = el("label", "inline");
      lb.append(sync, document.createTextNode("giọng đọc giống chữ hiển thị"));
      foot.append(lb);
    }
    if (b.voDurationSec) foot.append(el("span", "stat", `${b.voDurationSec.toFixed(2)}s`));
    if (b.startSec != null) foot.append(el("span", "stat", `bắt đầu ${b.startSec.toFixed(2)}s`));

    foot.append(el("div", "spacer"));
    const hear = el("button", "btn btn--soft btn--sm", "Nghe thử");
    hear.onclick = async () => {
      if (!(b.vo ?? "").trim()) return fail("Nhịp này chưa có câu đọc.");
      hear.disabled = true;
      try { await speak(b.vo); } catch (e) { fail(e); }
      finally { hear.disabled = false; }
    };
    foot.append(hear);
    fields.append(foot);

    body.append(fields);
    card.append(body);
    list.append(card);
  });
}

/** Bấm vào thumbnail để xoay vòng qua các media trong thư viện. */
function cycleMedia(beat) {
  const keys = Object.keys(state.project.media ?? {});
  if (!keys.length) return toast("Thư viện chưa có media — thêm ảnh hoặc video trước.");
  const cur = keys.indexOf(beat.mediaKey);
  beat.mediaKey = keys[(cur + 1) % keys.length];
  renderBeats();
  touch();
}

// ───────────────────────────────────────────── cài đặt chung

function renderSettings() {
  const p = state.project;
  $("#sourceLabel").value = p.brand.sourceLabel;
  $("#voiceRate").value = p.voice.rate;
  $("#voicePitch").value = p.voice.pitch ?? "+0Hz";
  $("#voiceId").value = p.voice.voiceId;
  $("#outroInfo").textContent = p.outro.src
    ? `Đang dùng ${p.outro.src} — ${p.outro.durationSec}s`
    : "Chưa có outro. Video sẽ kết thúc ngay ở nhịp cuối.";

  const bp = $("#badgePreview");
  bp.hidden = false;
  bp.onerror = () => { bp.hidden = true; };
  bp.src = fileUrl(p.brand.badgeSrc);

  const chip = $("#durChip");
  if (p.totalSec) {
    chip.hidden = false;
    chip.textContent = `${p.totalSec.toFixed(1)}s`;
  } else {
    chip.hidden = true;
  }
}

const renderAll = () => { renderMedia(); renderBeats(); renderSettings(); };

// ───────────────────────────────────────────── job + tiến trình

const STEP_ORDER = ["tts", "compose", "check", "render"];

function resetSteps() {
  for (const li of $$("#steps li")) li.className = "";
  const bar = $("#jobBar");
  bar.style.width = "0";
  bar.className = "";
  $("#jobLog").textContent = "";
}

function markStep(name, cls) {
  const at = STEP_ORDER.indexOf(name);
  if (at < 0) return;
  for (const s of STEP_ORDER.slice(0, at)) {
    const p = $(`#steps li[data-step="${s}"]`);
    if (p && !p.classList.contains("err")) p.className = "ok";
  }
  $(`#steps li[data-step="${name}"]`).className = cls;
  $("#jobBar").style.width = ((at + (cls === "ok" ? 1 : 0.45)) / STEP_ORDER.length) * 100 + "%";
}

/** Đoán bước đang chạy từ dòng log của pipeline. */
function sniffStep(line) {
  if (/^\[tts\]/.test(line)) markStep("tts", "run");
  else if (/^\[timeline\]|^\[compose\]/.test(line)) markStep("compose", "run");
  else if (/Chạy kiểm tra|^Lint|^Runtime|^Layout|^Contrast|Check passed/i.test(line)) markStep("check", "run");
  else if (/render|frame|ffmpeg|encod/i.test(line)) markStep("render", "run");
}

function setBusy(on) {
  for (const b of [$("#btnRender"), $("#btnPreview"), $("#btnPreviewStop")]) b.disabled = on;
}

function runJob(url, label, lastStep) {
  $("#jobState").textContent = label + "…";
  $("#jobState").className = "jobstate run";
  setBusy(true);

  return api(url, { method: "POST" })
    .then(({ jobId }) => new Promise((resolve, reject) => {
      const es = new EventSource(`/api/jobs/${jobId}/stream`);
      es.onmessage = (e) => {
        const d = JSON.parse(e.data);
        if (d.line) {
          const log = $("#jobLog");
          log.textContent += d.line + "\n";
          log.scrollTop = log.scrollHeight;
          sniffStep(d.line);
        }
        if (d.state === "done") {
          es.close();
          if (lastStep) markStep(lastStep, "ok");
          $("#jobBar").style.width = "100%";
          $("#jobState").textContent = label + " xong";
          $("#jobState").className = "jobstate ok";
          resolve(d.result);
        } else if (d.state === "error") {
          es.close();
          for (const li of $$("#steps li.run")) li.className = "err";
          $("#jobBar").className = "err";
          $("#jobState").textContent = label + " lỗi";
          $("#jobState").className = "jobstate err";
          $("#logBox").open = true;
          reject(new Error(d.error));
        }
      };
      es.onerror = () => { es.close(); reject(new Error("Mất kết nối tới tiến trình.")); };
    }))
    .finally(() => setBusy(false));
}

// ───────────────────────────────────────────── nghe thử giọng

async function speak(text) {
  await api(`/api/projects/${state.id}/voice-preview`, {
    method: "POST",
    body: JSON.stringify({
      text,
      voiceId: $("#voiceId").value,
      rate: $("#voiceRate").value,
      pitch: $("#voicePitch").value,
    }),
  });
  const a = $("#voiceAudio");
  a.src = `/api/projects/${state.id}/file/assets/preview/voice-preview.mp3?t=${Date.now()}`;
  a.hidden = false;
  await a.play().catch(() => {});
}

// ═════════════════════════════════════════ gắn sự kiện ════════════════════

// thẻ gập ở cột trái
for (const head of $$(".card-head[data-toggle]")) {
  head.onclick = () => head.closest(".card").classList.toggle("is-open");
}

on("#btnTheme", "click", () => {
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  applyTheme(dark ? "light" : "dark");
});

// menu chọn dự án
on("#projBtn", "click", (e) => {
  e.stopPropagation();
  const m = $("#projMenu");
  m.hidden = !m.hidden;
  $("#projBtn").setAttribute("aria-expanded", String(!m.hidden));
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".proj-switch")) closeProjMenu();
});

// dự án mới
on("#btnFirst", "click", askNewProject);
on("#newCancel", "click", (e) => { e.preventDefault(); $("#newDlg").close(); });
on("#newOk", "click", async (e) => {
  e.preventDefault();
  const title = $("#newTitle").value.trim();
  if (!title) return;
  $("#newDlg").close();
  try {
    const { id } = await api("/api/projects", { method: "POST", body: JSON.stringify({ title }) });
    await refreshProjects(id);
    toast("Đã tạo dự án.", "ok");
  } catch (x) { fail(x); }
});

// thêm media từ hộp chọn file
on("#btnUpload", "click", () => $("#fileInput").click());
on("#fileInput", "change", async (e) => {
  await addFiles([...e.target.files]).catch(fail);
  e.target.value = "";
});

// kéo thả file vào cả cửa sổ
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
/** Đang kéo một media từ thư viện (không phải file từ ngoài vào). */
const keoMedia = (e) => [...(e.dataTransfer?.types ?? [])].includes("text/media-key");

/* dragenter/dragleave bắn liên tục khi con trỏ đi qua từng phần tử con, nên
   đếm độ sâu thay vì tắt ngay ở lần dragleave đầu tiên. */
let dragDepth = 0;

function showDropCue(on) {
  $("#dropveil").hidden = !on;
  $("#mediaCard")?.classList.toggle("is-target", on);
  if (!on) {
    $("#dropzone").classList.remove("hot");
    document.querySelector(".media-add")?.classList.remove("hot");
  }
}

window.addEventListener("dragenter", (e) => {
  if (!hasFiles(e) || !state.id) return;
  dragDepth++;
  showDropCue(true);
});
window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) { dragDepth = 0; showDropCue(false); }
});
// rê ra ngoài cửa sổ rồi thả ở chỗ khác thì không có sự kiện drop -> tự dọn
window.addEventListener("dragend", () => { dragDepth = 0; showDropCue(false); });

window.addEventListener("drop", async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  showDropCue(false);
  if (!state.id) return fail("Tạo dự án trước đã.");
  await addFiles([...e.dataTransfer.files]).catch(fail);
});

// vùng thả trong cột trái sáng thêm một bậc khi con trỏ ở đúng trên nó
const dz = $("#dropzone");
dz.addEventListener("dragover", (e) => { if (hasFiles(e)) { e.preventDefault(); dz.classList.add("hot"); } });
dz.addEventListener("dragleave", () => dz.classList.remove("hot"));
dz.addEventListener("drop", () => dz.classList.remove("hot"));

// thêm nhịp
on("#btnAddBeat", "click", () => {
  state.project.beats.push(newBeat());
  renderBeats();
  touch();
  $("#beatList").lastElementChild?.querySelector("textarea")?.focus();
});

// dán văn bản → tách thành nhịp
on("#btnPasteText", "click", () => {
  $("#pasteText").value = "";
  // bỏ tick mỗi lần mở: giữ nguyên trạng thái cũ dễ khiến người dùng vô tình
  // xoá sạch kịch bản ở lần dán sau
  $("#pasteReplace").checked = false;
  $("#pasteDlg").showModal();
  $("#pasteText").focus();
});
on("#pasteCancel", "click", (e) => { e.preventDefault(); $("#pasteDlg").close(); });
on("#pasteOk", "click", async (e) => {
  e.preventDefault();
  const text = $("#pasteText").value.trim();
  if (!text) return;
  try {
    const { beats } = await api("/api/split-text", { method: "POST", body: JSON.stringify({ text }) });
    if (!beats.length) return fail("Không tách được nhịp nào từ đoạn này.");
    if ($("#pasteReplace").checked) state.project.beats = [];
    for (const t of beats) state.project.beats.push(newBeat(t));
    $("#pasteDlg").close();
    renderBeats();
    touch();
    toast(`Đã tạo ${beats.length} nhịp.`, "ok");
  } catch (x) { fail(x); }
});

// cài đặt chung
on("#sourceLabel", "input", (e) => { state.project.brand.sourceLabel = e.target.value; touch(); });
on("#voiceRate", "change", (e) => { state.project.voice.rate = e.target.value; invalidateVo(); touch(); });
on("#voicePitch", "change", (e) => { state.project.voice.pitch = e.target.value; invalidateVo(); touch(); });
on("#voiceId", "change", (e) => {
  state.project.voice.voiceId = e.target.value;
  invalidateVo();
  touch();
});

/** Đổi giọng hoặc tốc độ thì mọi độ dài đã đo không còn đúng nữa. */
function invalidateVo() {
  for (const b of state.project.beats) delete b.voDurationSec;
  renderBeats();
}

on("#btnVoiceTest", "click", async () => {
  const text = $("#voiceTest").value.trim() || state.project.beats.find((b) => b.vo)?.vo;
  if (!text) return fail("Nhập một câu để nghe thử.");
  $("#btnVoiceTest").disabled = true;
  try { await speak(text); } catch (e) { fail(e); }
  finally { $("#btnVoiceTest").disabled = false; }
});

on("#btnBadge", "click", () => $("#badgeInput").click());
on("#badgeInput", "change", async (e) => {
  if (!e.target.files[0]) return;
  const fd = new FormData();
  fd.append("file", e.target.files[0]);
  try {
    const r = await api(`/api/projects/${state.id}/badge`, { method: "POST", body: fd });
    if (r.size) {
      state.project.brand.badgeWidth = r.size.width;
      state.project.brand.badgeHeight = r.size.height;
    }
    state.stamp = Date.now();
    renderSettings();
    touch();
    toast("Đã đổi logo.", "ok");
  } catch (x) { fail(x); }
  e.target.value = "";
});

on("#btnOutro", "click", () => $("#outroInput").click());
on("#outroInput", "change", async (e) => {
  if (!e.target.files[0]) return;
  const fd = new FormData();
  fd.append("file", e.target.files[0]);
  try {
    const r = await api(`/api/projects/${state.id}/outro`, { method: "POST", body: fd });
    state.project.outro = { src: r.src, durationSec: r.durationSec };
    renderSettings();
    touch();
    toast(`Đã gắn outro ${r.durationSec}s.`, "ok");
  } catch (x) { fail(x); }
  e.target.value = "";
});

// ═══════════════════════ tự điền dự án: tin mới / link / bảng ══════════════

/**
 * Gọi một endpoint tự dựng dự án rồi mở luôn dự án vừa tạo.
 * Ba nguồn (tin mới, link bài báo, file bảng) chỉ khác nhau ở cách gửi.
 */
async function dungTuNguon(url, opts, dangLam) {
  const cu = $("#jobState").textContent;
  $("#jobState").textContent = dangLam + "…";
  $("#jobState").className = "jobstate run";
  try {
    const r = await api(url, opts);
    await refreshProjects(r.id);
    $("#jobState").textContent = "Đã dựng dự án";
    $("#jobState").className = "jobstate ok";
    toast(`Đã dựng dự án: ${r.soNhip} nhịp, ${r.soAnh} ảnh.`, "ok");
    return r;
  } catch (e) {
    $("#jobState").textContent = cu;
    $("#jobState").className = "jobstate";
    fail(e);
    return null;
  }
}

// ── tin mới trong ngày ──────────────────────────────────────────────────
async function layTinMoi() {
  const q = $("#newsQuery").value.trim() || "tin mới ielts";
  const nut = $("#btnNews");
  nut.disabled = true;
  nut.textContent = "Đang lấy…";
  try {
    const { items } = await api(`/api/news?q=${encodeURIComponent(q)}`);
    veTin(items);
    $("#newsCount").textContent = String(items.length);
    if (!items.length) toast("Không tìm thấy tin nào cho từ khoá này.");
  } catch (e) {
    fail(e);
  } finally {
    nut.disabled = false;
    nut.textContent = "Lấy tin";
  }
}

function veTin(items) {
  const box = $("#newsList");
  box.innerHTML = "";
  items.forEach((it, i) => {
    const b = el("button", "news-item");
    b.title = it.link;
    b.append(el("span", "stt", String(i + 1)));
    const nd = el("div", "noi-dung");
    nd.append(el("div", "tieu-de", it.title), el("div", "bao", it.source || ""));
    b.append(nd);
    b.onclick = async () => {
      for (const x of $$(".news-item")) x.disabled = true;
      b.textContent = "Đang dựng dự án…";
      await dungTuNguon(
        "/api/projects/from-article",
        { method: "POST", body: JSON.stringify({ url: it.link }) },
        "Dựng từ bài báo",
      );
      veTin(items); // vẽ lại để bỏ trạng thái khoá
    };
    box.append(b);
  });
}

on("#btnNews", "click", layTinMoi);
on("#newsQuery", "keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); layTinMoi(); } });

// ── từ một link bài báo ─────────────────────────────────────────────────
async function dungTuLink() {
  const url = $("#articleUrl").value.trim();
  if (!url) return fail("Chưa dán link bài báo.");
  const nut = $("#btnExtract");
  nut.disabled = true;
  nut.textContent = "Đang dựng…";
  const r = await dungTuNguon(
    "/api/projects/from-article",
    { method: "POST", body: JSON.stringify({ url }) },
    "Dựng từ bài báo",
  );
  if (r) $("#articleUrl").value = "";
  nut.disabled = false;
  nut.textContent = "Dựng";
}
on("#btnExtract", "click", dungTuLink);
on("#articleUrl", "keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); dungTuLink(); } });

// ── từ file bảng ────────────────────────────────────────────────────────
on("#btnSheet", "click", () => $("#sheetInput").click());
on("#sheetInput", "change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const fd = new FormData();
  fd.append("file", f);
  await dungTuNguon("/api/projects/from-sheet", { method: "POST", body: fd }, "Đọc bảng");
  e.target.value = "";
});

on("#btnSheetUrl", "click", async () => {
  const url = $("#sheetUrl").value.trim();
  if (!url) return fail("Chưa dán link bảng.");
  const r = await dungTuNguon(
    "/api/projects/from-sheet",
    { method: "POST", body: JSON.stringify({ url }) },
    "Đọc bảng",
  );
  if (r) $("#sheetUrl").value = "";
});

// bấm ra vùng nền tối cũng đóng hộp thoại
for (const d of document.querySelectorAll("dialog")) {
  d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
}

// xem trước trong HyperFrames Studio
on("#btnPreview", "click", async () => {
  try {
    resetSteps();
    await saveProject();
    await runJob(`/api/projects/${state.id}/build`, "Dựng", "check");
    await openProject(state.id);
    const r = await runJob(`/api/projects/${state.id}/preview`, "Mở xem trước");
    $("#btnPreviewStop").hidden = false;
    if (r?.url) window.open(r.url, "_blank");
    else toast("Đã bật xem trước — xem nhật ký để lấy địa chỉ.");
  } catch (e) { fail(e); }
});

on("#btnPreviewStop", "click", async () => {
  try {
    await runJob(`/api/projects/${state.id}/preview-stop`, "Dừng xem trước");
    $("#btnPreviewStop").hidden = true;
  } catch (e) { fail(e); }
});

// render ra MP4
on("#btnRender", "click", async () => {
  const p = state.project;
  if (!p.beats.length) return fail("Chưa có nhịp nào.");
  const noMedia = p.beats.filter((b) => !b.mediaKey).length;
  if (noMedia && !confirm(`${noMedia} nhịp chưa gán ảnh hoặc video. Vẫn tạo video?`)) return;

  const lowres = [...new Set(p.beats.map((b) => b.mediaKey))]
    .filter((k) => p.media[k] && isLowRes(p.media[k]));
  if (lowres.length && !confirm(
    `${lowres.length} ảnh đang dùng có độ phân giải quá thấp so với khung hình nên sẽ vỡ hạt. Vẫn tạo video?`,
  )) return;

  try {
    resetSteps();
    await saveProject();
    await runJob(`/api/projects/${state.id}/build`, "Dựng", "check");
    await openProject(state.id);
    const r = await runJob(`/api/projects/${state.id}/render`, "Render", "render");

    $("#resultPanel").hidden = false;
    $("#resultVideo").src = r.url;
    $("#resultInfo").textContent = r.durationSec ? `${r.durationSec.toFixed(2)} giây · ${r.file}` : r.file;
    $("#resultPath").textContent = r.absolutePath;
    const reveal = $("#btnReveal");
    if (reveal) {
      reveal.onclick = () =>
        api("/api/reveal", { method: "POST", body: JSON.stringify({ absolutePath: r.absolutePath }) })
          .catch(fail);
    }
    $("#resultPanel").scrollIntoView({ behavior: "smooth", block: "nearest" });
    toast("Video đã xong.", "ok");
  } catch (e) { fail(e); }
});

// phím tắt Ctrl+S
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    saveProject().then(() => toast("Đã lưu.", "ok")).catch(fail);
  }
});

// còn thay đổi chưa kịp lưu thì hỏi lại trước khi đóng tab
window.addEventListener("beforeunload", (e) => {
  if ($("#saveState").classList.contains("saving")) {
    e.preventDefault();
    e.returnValue = "";
  }
});

// ───────────────────────────────────────────── khởi động

/** Dựng ba ô chọn: giọng, tốc độ, cao độ. */
function fillVoiceControls({ voices, rates, pitches }) {
  state.voices = voices;

  const sel = $("#voiceId");
  sel.innerHTML = "";
  for (const v of voices) {
    const o = el("option", null, `${v.label} (${v.gender})`);
    o.value = v.id;
    sel.append(o);
  }

  for (const [id, list] of [["#voiceRate", rates], ["#voicePitch", pitches]]) {
    const n = $(id);
    n.innerHTML = "";
    for (const r of list) {
      const o = el("option", null, r.label);
      o.value = r.value;
      n.append(o);
    }
  }
}

(async function init() {
  try {
    fillVoiceControls(await api("/api/voices"));
    await refreshProjects();
  } catch (e) {
    fail(e);
  }
})();
