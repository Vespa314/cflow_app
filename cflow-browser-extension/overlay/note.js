"use strict";

// 「cflow笔记模式」（右键或工具栏弹窗）注入的页内浮动编辑器：可拖拽（顶栏）/可缩放（右下角），置于页面所有元素之上。
// 与 common.js 注入到同一隔离世界，直接使用其全局（loadSettings/persist/api 等）；
// 创建笔记与拉取空间受页面 CORS 限制，统一经 background 代理（createMemo / getSpaces）。

(async function () {
  // 同页重复注入：先卸载上一实例（DOM + 监听 + 定时器）
  if (typeof window.__cflowNoteClose === "function") {
    try {
      window.__cflowNoteClose();
    } catch (e) {
      /* 旧实例已残缺则忽略 */
    }
  }
  // 标记本页已注入样式：background 据此跳过重复 insertCSS（与 overlay.js 共用 overlay.css）
  window.__cflowOverlayReady = true;

  await loadSettings();

  const MIN_W = 280;
  const MIN_H = 200;
  // 定时器/清理句柄必须在首个 await 之前声明：IIFE 中途一旦异常中止（如未配置时的
  // toast），仍会被调用的 close() 若踩到 let/const 暂时性死区会 ReferenceError，
  // 连带 root.remove() 都执行不到（面板关不掉的根因）
  let toastTimer = null;
  let draftTimer = null;
  let videoProbe = null;
  let destroyTagSuggest = () => {};
  let destroyListEditing = () => {};

  /* ---------- 构建 DOM ---------- */

  const root = document.createElement("div");
  root.id = "cflow-note";
  root.className = "cflow-note";
  root.lang = "zh-CN";

  const topbar = document.createElement("div");
  topbar.className = "cflow-note-topbar";
  const brand = document.createElement("div");
  brand.className = "cflow-note-brand";
  const brandIcon = document.createElement("span");
  brandIcon.textContent = "🌿";
  const brandText = document.createElement("span");
  brandText.textContent = "cflow笔记";
  brand.append(brandIcon, brandText);
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "cflow-close";
  closeBtn.title = "关闭 (Esc)";
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", close);
  topbar.append(brand, closeBtn);

  const editor = document.createElement("textarea");
  editor.className = "cflow-note-editor";
  editor.placeholder = "随手记点什么…";
  editor.spellcheck = false;

  const actions = document.createElement("div");
  actions.className = "cflow-note-actions";
  const spaceSelect = document.createElement("select");
  spaceSelect.className = "cflow-note-space";
  spaceSelect.setAttribute("aria-label", "保存到空间");
  const videoBtn = document.createElement("button");
  videoBtn.type = "button";
  videoBtn.className = "cflow-note-vtime";
  videoBtn.textContent = "插入视频时间";
  videoBtn.hidden = true;
  videoBtn.addEventListener("click", insertVideoTime);
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "cflow-note-save";
  saveBtn.textContent = "保存";
  saveBtn.addEventListener("click", save);
  actions.append(spaceSelect, videoBtn, saveBtn);

  const resizeHandle = document.createElement("div");
  resizeHandle.className = "cflow-note-resize";
  resizeHandle.title = "拖动缩放";

  // 本地 toast：不复用 common.js 的 #cflow-toast（摘录层同时打开时 id 冲突）
  const toastEl = document.createElement("div");
  toastEl.className = "cflow-note-toast";
  toastEl.hidden = true;

  root.append(topbar, editor, actions, resizeHandle, toastEl);
  document.documentElement.appendChild(root);

  // 默认停靠视口右上角，放不下时收窄
  const width = Math.min(420, window.innerWidth - 24);
  root.style.width = width + "px";
  root.style.height = Math.min(300, Math.max(MIN_H, window.innerHeight - 160)) + "px";
  root.style.left = Math.max(8, window.innerWidth - width - 24) + "px";
  root.style.top = Math.max(8, Math.min(72, window.innerHeight - MIN_H)) + "px";

  editor.focus();

  /* ---------- 拖拽与缩放（Pointer Events + 指针捕获，快速拖出窗口不丢事件） ---------- */

  topbar.addEventListener("pointerdown", (e) => {
    if (e.target === closeBtn || e.button !== 0) return;
    e.preventDefault();
    const rect = root.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;
    topbar.setPointerCapture(e.pointerId);
    const onMove = (ev) => {
      // 至少留 48px 宽、顶栏可达，避免拖出视口后找不回
      const left = Math.min(Math.max(ev.clientX - offsetX, 48 - rect.width), window.innerWidth - 48);
      const top = Math.min(Math.max(ev.clientY - offsetY, 0), window.innerHeight - 36);
      root.style.left = left + "px";
      root.style.top = top + "px";
    };
    const onUp = () => {
      topbar.removeEventListener("pointermove", onMove);
      topbar.removeEventListener("pointerup", onUp);
      topbar.removeEventListener("pointercancel", onUp);
    };
    topbar.addEventListener("pointermove", onMove);
    topbar.addEventListener("pointerup", onUp);
    topbar.addEventListener("pointercancel", onUp);
  });

  resizeHandle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const rect = root.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = rect.width;
    const startH = rect.height;
    resizeHandle.setPointerCapture(e.pointerId);
    const onMove = (ev) => {
      const w = Math.min(Math.max(startW + ev.clientX - startX, MIN_W), window.innerWidth - 8);
      const h = Math.min(Math.max(startH + ev.clientY - startY, MIN_H), window.innerHeight - 8);
      root.style.width = w + "px";
      root.style.height = h + "px";
    };
    const onUp = () => {
      resizeHandle.removeEventListener("pointermove", onMove);
      resizeHandle.removeEventListener("pointerup", onUp);
      resizeHandle.removeEventListener("pointercancel", onUp);
    };
    resizeHandle.addEventListener("pointermove", onMove);
    resizeHandle.addEventListener("pointerup", onUp);
    resizeHandle.addEventListener("pointercancel", onUp);
  });

  /* ---------- 空间下拉 ---------- */

  // 默认空间的 id 是空字符串。直接拿它当 <option value> 时，select.value 也是 ""，
  // 和「没选中」无法区分，保存处的 !spaceId 会把默认空间误判成「暂无可用空间」。
  const DEFAULT_SPACE_OPTION = "__default__";

  function encodeSpaceOption(spaceId) {
    return spaceId === "" ? DEFAULT_SPACE_OPTION : spaceId;
  }

  function decodeSpaceOption(value) {
    return value === DEFAULT_SPACE_OPTION ? "" : value;
  }

  // 返回当前选中的真实 spaceId（默认空间为 ""）；没有可用选中项时返回 null
  function currentSpaceId() {
    if (spaceSelect.disabled) return null;
    const opt = spaceSelect.selectedOptions[0];
    if (!opt || opt.value === "") return null;
    const spaceId = decodeSpaceOption(opt.value);
    if (!state.spaces.some((s) => s.spaceId === spaceId)) return null;
    return spaceId;
  }

  function selectSpace(spaceId) {
    if (spaceId == null) return;
    const encoded = encodeSpaceOption(spaceId);
    if ([...spaceSelect.options].some((o) => o.value === encoded)) spaceSelect.value = encoded;
  }

  function fillSpaces() {
    const prevId = currentSpaceId();
    spaceSelect.textContent = "";
    if (!state.spaces.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "暂无空间";
      spaceSelect.appendChild(opt);
      spaceSelect.disabled = true;
      return;
    }
    spaceSelect.disabled = false;
    for (const space of orderedSpaces()) {
      const opt = document.createElement("option");
      opt.value = encodeSpaceOption(space.spaceId);
      opt.textContent = spaceDisplayName(space);
      spaceSelect.appendChild(opt);
    }
    selectSpace(prevId != null ? prevId : state.lastSpaceId);
  }

  fillSpaces();
  if (!isConfigured()) {
    toast("尚未配置，请先点击浏览器工具栏的 cflow 图标完成设置", true);
  }
  // 缓存为空时经后台拉取一次（页面上下文受 CORS 限制不能直接 fetch）
  else if (!state.spaces.length) {
    chrome.runtime.sendMessage({ type: "getSpaces" }, (resp) => {
      if (chrome.runtime.lastError) resp = { ok: false, error: chrome.runtime.lastError.message };
      if (resp && resp.ok) {
        state.spaces = resp.spaces || [];
        state.lastSpaceId = resp.lastSpaceId ?? null;
        fillSpaces();
        restoreDraft();
      } else if (resp && resp.error) {
        toast(resp.error, true);
      }
    });
  }

  /* ---------- 草稿 ---------- */

  async function saveDraft() {
    const content = editor.value;
    if (!content.trim()) {
      await persist({ [PAGE_DRAFT_KEY]: null });
      return;
    }
    const spaceId = currentSpaceId();
    await persist({ [PAGE_DRAFT_KEY]: { content, spaceId: spaceId == null ? "" : spaceId, updatedAt: Date.now() } });
  }

  function scheduleDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, 400);
  }

  async function restoreDraft() {
    const data = await chrome.storage.local.get(PAGE_DRAFT_KEY);
    const draft = data && data[PAGE_DRAFT_KEY];
    if (draft && typeof draft.content === "string" && draft.content) {
      editor.value = draft.content;
      if (draft.spaceId != null) selectSpace(draft.spaceId);
    }
  }
  await restoreDraft();

  editor.addEventListener("input", scheduleDraft);
  spaceSelect.addEventListener("change", scheduleDraft);

  // # 标签联想：候选取当前所选空间的标签（页面上下文 CORS 受限，经后台代理拉取）
  destroyTagSuggest = attachTagSuggest(editor, () => {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "getTags", spaceId: currentSpaceId() ?? "" }, (resp) => {
        if (chrome.runtime.lastError) resp = { ok: false };
        if (resp && resp.ok) resolve(resp.tags || []);
        else reject(new Error((resp && resp.error) || "拉取标签失败"));
      });
    });
  });
  destroyListEditing = attachListEditing(editor);

  /* ---------- 视频时间插入 ---------- */

  // 页面里有视频正在播放才显示按钮；多路播放取画面最大的
  function playingVideo() {
    let best = null;
    let bestArea = 0;
    for (const v of document.querySelectorAll("video")) {
      if (v.paused || v.ended || v.readyState < 2) continue;
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) {
        bestArea = area;
        best = v;
      }
    }
    return best;
  }

  let lastVideo = null;
  videoProbe = setInterval(() => {
    const v = playingVideo();
    if (v) lastVideo = v;
    videoBtn.hidden = !v;
  }, 800);

  function formatTime(totalSec) {
    const sec = Math.max(0, Math.floor(totalSec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const mm = String(m).padStart(2, "0");
    const ss = String(s).padStart(2, "0");
    return h > 0 ? h + ":" + mm + ":" + ss : mm + ":" + ss;
  }

  function insertVideoTime() {
    // 检测间隙里刚暂停的视频也允许插入（画面还在），完全找不到才提示
    const v = playingVideo() || (lastVideo && lastVideo.isConnected ? lastVideo : null);
    if (!v) {
      toast("没有正在播放的视频", true);
      return;
    }
    const stamp = formatTime(v.currentTime) + " ";
    const pos = editor.selectionStart ?? editor.value.length;
    // 光标已在新一行行首则直接插入，否则先补一个换行
    const atLineHead = pos === 0 || editor.value[pos - 1] === "\n";
    const insert = (atLineHead ? "" : "\n") + stamp;
    editor.setRangeText(insert, pos, pos, "end");
    editor.focus();
    scheduleDraft();
  }

  /* ---------- 保存 ---------- */

  let saving = false;

  function save() {
    if (saving) return;
    let content = editor.value.trim();
    if (!content) {
      toast("先写点内容再保存吧", true);
      return;
    }
    // 按字节判定（common.js 同款注释）：中文按 UTF-16 长度判会漏放大约 3 倍的量
    if (new TextEncoder().encode(content).length > MAX_TEXT_LENGTH) content = truncateUtf8Bytes(content, MAX_TEXT_LENGTH);
    const spaceId = currentSpaceId();
    if (spaceId == null) {
      toast("暂无可用空间，请到插件设置里检查", true);
      return;
    }

    saving = true;
    saveBtn.disabled = true;
    saveBtn.textContent = "保存中…";
    chrome.runtime.sendMessage({ type: "createMemo", spaceId, content }, (resp) => {
      if (chrome.runtime.lastError) resp = { ok: false, error: chrome.runtime.lastError.message };
      saving = false;
      saveBtn.disabled = false;
      saveBtn.textContent = "保存";
      if (resp && resp.ok) {
        state.lastSpaceId = spaceId;
        editor.value = "";
        persist({ [PAGE_DRAFT_KEY]: null });
        toast("已保存 ✓");
      } else {
        toast((resp && resp.error) || "保存失败，请重试", true);
      }
    });
  }

  /* ---------- Toast ---------- */

  function toast(msg, isError) {
    toastEl.textContent = msg;
    toastEl.classList.toggle("toast-error", !!isError);
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.hidden = true), 2600);
  }

  /* ---------- 关闭 ---------- */

  function close() {
    destroyTagSuggest();
    destroyListEditing();
    clearInterval(videoProbe);
    clearTimeout(draftTimer);
    clearTimeout(toastTimer);
    // 关窗前把未落盘的草稿补存（空内容则清掉）
    saveDraft();
    root.remove();
    document.removeEventListener("keydown", onKeydown);
    window.__cflowNoteClose = null;
  }

  function onKeydown(e) {
    if (e.key === "Escape") close();
  }
  document.addEventListener("keydown", onKeydown);
  // 供同页再次注入时卸载本实例
  window.__cflowNoteClose = close;
})();
