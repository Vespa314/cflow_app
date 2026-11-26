"use strict";

// 「cflow笔记模式」（右键或工具栏弹窗）注入的页内浮动编辑器：可拖拽（顶栏）/可缩放（右下角），置于页面所有元素之上。
// 与 common.js 注入到同一隔离世界，直接使用其全局（loadSettings/persist/api 等）；
// 创建笔记、上传图片与拉取空间受页面 CORS 限制，统一经 background 代理。
// 图片池（Ctrl+V 粘贴 / 视频截图）先本地暂存，点保存才上传，流程与安卓端一致。

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
  // 附加行（缩略图条 / 视频工具行）与编辑区之间的间距，与 overlay.css 的 margin-top 一致
  const ROW_GAP = 8;
  // 定时器/清理句柄必须在首个 await 之前声明：IIFE 中途一旦异常中止（如未配置时的
  // toast），仍会被调用的 close() 若踩到 let/const 暂时性死区会 ReferenceError，
  // 连带 root.remove() 都执行不到（面板关不掉的根因）
  let toastTimer = null;
  let draftTimer = null;
  let videoProbe = null;
  let destroyTagSuggest = () => {};
  let destroyListEditing = () => {};
  let saving = false;
  // 图片池每项 { id, dataUrl, type, filename, resourceId? }。resourceId 是保存失败重试时复用的已上传 id：
  // 重传会拿到新 id，笔记上就会多出一份重复附件
  let pool = [];

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
  editor.placeholder = "随手记点什么，Ctrl+V 可直接粘贴图片";
  editor.spellcheck = false;

  // 图片池缩略图条（有图才显示）
  const thumbs = document.createElement("div");
  thumbs.className = "cflow-note-thumbs";
  thumbs.hidden = true;

  // 视频工具行：页面里有视频才显示
  const videoBar = document.createElement("div");
  videoBar.className = "cflow-note-videobar";
  const videoBtn = document.createElement("button");
  videoBtn.type = "button";
  videoBtn.className = "cflow-note-tool";
  videoBtn.textContent = "插入视频时间";
  videoBtn.addEventListener("click", insertVideoTime);
  const snapBtn = document.createElement("button");
  snapBtn.type = "button";
  snapBtn.className = "cflow-note-tool";
  snapBtn.textContent = "截取视频画面";
  snapBtn.addEventListener("click", captureVideoFrame);
  videoBar.append(videoBtn, snapBtn);
  videoBar.hidden = true;

  const actions = document.createElement("div");
  actions.className = "cflow-note-actions";
  const spaceSelect = document.createElement("select");
  spaceSelect.className = "cflow-note-space";
  spaceSelect.setAttribute("aria-label", "保存到空间");
  const linkBtn = document.createElement("button");
  linkBtn.type = "button";
  linkBtn.className = "cflow-note-tool";
  linkBtn.textContent = "插入网址";
  linkBtn.addEventListener("click", insertPageLink);
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "cflow-note-save";
  saveBtn.textContent = "保存";
  saveBtn.addEventListener("click", save);
  actions.append(spaceSelect, linkBtn, saveBtn);

  const resizeHandle = document.createElement("div");
  resizeHandle.className = "cflow-note-resize";
  resizeHandle.title = "拖动缩放";

  // 本地 toast：不复用 common.js 的 #cflow-toast（摘录层同时打开时 id 冲突）
  const toastEl = document.createElement("div");
  toastEl.className = "cflow-note-toast";
  toastEl.hidden = true;

  root.append(topbar, editor, thumbs, videoBar, actions, resizeHandle, toastEl);
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
    send({ type: "getSpaces" }).then((resp) => {
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
  await restoreImages();

  editor.addEventListener("input", scheduleDraft);
  spaceSelect.addEventListener("change", scheduleDraft);

  // # 标签联想：候选取当前所选空间的标签（页面上下文 CORS 受限，经后台代理拉取）
  destroyTagSuggest = attachTagSuggest(editor, () => {
    return send({ type: "getTags", spaceId: currentSpaceId() ?? "" }).then((resp) => {
      if (resp && resp.ok) return resp.tags || [];
      throw new Error((resp && resp.error) || "拉取标签失败");
    });
  });
  destroyListEditing = attachListEditing(editor);

  /* ---------- 插入当前网页链接 ---------- */

  function insertPageLink() {
    const insert = markdownLink(document.title, location.href);
    const pos = editor.selectionStart ?? editor.value.length;
    editor.setRangeText(insert, pos, pos, "end");
    editor.focus();
    scheduleDraft();
  }

  /* ---------- 视频：插入时间 / 截取画面 ---------- */

  // 页面里存在视频（暂停也算）就算有；多路取画面最大的
  function pageVideo() {
    let best = null;
    let bestArea = 0;
    for (const v of document.querySelectorAll("video")) {
      if (v.readyState < 2) continue;
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) {
        bestArea = area;
        best = v;
      }
    }
    return best;
  }

  function probeVideo() {
    setRowVisible(videoBar, !!pageVideo());
  }
  videoProbe = setInterval(probeVideo, 800);
  probeVideo();

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
    const v = pageVideo();
    if (!v) {
      toast("页面上没有视频", true);
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

  function canvasToJpeg(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("图片编码失败"))), "image/jpeg", 0.92);
    });
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      // 页面 CSP 的 img-src 不含 data: 时会走到这里
      img.onerror = () => reject(new Error("当前网页的安全策略不允许处理截图"));
      img.src = src;
    });
  }

  function nextFrame() {
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }

  // 首选直接取视频帧：原分辨率、无字幕控件等覆盖层。跨域且未开 CORS 的视频（YouTube/B站等）
  // 会污染画布，toBlob 抛 SecurityError，返回 null 交给截标签页兜底
  async function drawVideoFrame(v) {
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext("2d").drawImage(v, 0, 0, canvas.width, canvas.height);
    try {
      return await canvasToJpeg(canvas);
    } catch (err) {
      return null;
    }
  }

  // 兜底：后台截标签页可见区域，再裁到视频位置。只能拿到可视范围内的画面，字幕/控件也会截进去
  async function captureTabFrame(v) {
    const rect = v.getBoundingClientRect();
    const clip = {
      left: Math.max(rect.left, 0),
      top: Math.max(rect.top, 0),
      right: Math.min(rect.right, document.documentElement.clientWidth),
      bottom: Math.min(rect.bottom, window.innerHeight),
    };
    if (clip.right - clip.left < 16 || clip.bottom - clip.top < 16) {
      toast("视频不在可视区域内，先滚动到视频位置再截", true);
      return null;
    }
    // 截图前先藏起自己的面板，等合成器刷过一帧再截
    root.style.visibility = "hidden";
    let resp;
    try {
      await nextFrame();
      resp = await send({ type: "captureTab" });
    } finally {
      root.style.visibility = "";
    }
    if (!resp || !resp.ok) {
      toast((resp && resp.error) || "截图失败，请重试", true);
      return null;
    }
    try {
      const img = await loadImage(resp.dataUrl);
      // 截图是设备像素，按「截图宽 / 视口宽」换算裁剪区域
      const scale = img.naturalWidth / window.innerWidth;
      const w = Math.round((clip.right - clip.left) * scale);
      const h = Math.round((clip.bottom - clip.top) * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(img, clip.left * scale, clip.top * scale, w, h, 0, 0, w, h);
      return await canvasToJpeg(canvas);
    } catch (err) {
      toast(err.message || "截图失败，请重试", true);
      return null;
    }
  }

  async function captureVideoFrame() {
    if (snapBtn.disabled) return;
    const v = pageVideo();
    if (!v) {
      toast("页面上没有视频", true);
      return;
    }
    snapBtn.disabled = true;
    try {
      const blob = (await drawVideoFrame(v)) || (await captureTabFrame(v));
      if (blob) await addImage(blob, "视频截图 " + formatTime(v.currentTime).replace(/:/g, "-") + ".jpg");
    } catch (err) {
      toast(err.message || "截图失败，请重试", true);
    } finally {
      snapBtn.disabled = false;
      editor.focus();
    }
  }

  /* ---------- 图片池（进池不上传，点保存才传） ---------- */

  // http 页面不是安全上下文，没有 crypto.randomUUID
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function imageExt(type) {
    const sub = String(type || "").split("/")[1];
    return { jpeg: "jpg", "svg+xml": "svg" }[sub] || sub || "png";
  }

  // 文件名里的时间戳：20261127-153012
  function fileStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return (
      d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
    );
  }

  function readAsDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("无法读取图片"));
      reader.readAsDataURL(blob);
    });
  }

  // 附加行显示/隐藏时同步增减面板高度，编辑区不被挤压
  function setRowVisible(el, visible) {
    if (el.hidden === !visible) return;
    const before = el.hidden ? 0 : el.offsetHeight + ROW_GAP;
    el.hidden = !visible;
    const after = el.hidden ? 0 : el.offsetHeight + ROW_GAP;
    const h = root.getBoundingClientRect().height + after - before;
    root.style.height = Math.min(Math.max(h, MIN_H), window.innerHeight - 8) + "px";
  }

  function appendThumb(item) {
    const cell = document.createElement("div");
    cell.className = "cflow-note-thumb";
    cell.dataset.id = item.id;
    const img = document.createElement("img");
    img.alt = item.filename;
    img.draggable = false;
    // 页面 CSP 的 img-src 不含 data: 时缩略图加载失败：退成占位块，上传不受影响
    img.onerror = () => cell.classList.add("thumb-broken");
    img.src = item.dataUrl;
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "cflow-note-thumb-remove";
    rm.title = "移除";
    rm.setAttribute("aria-label", "移除图片");
    rm.textContent = "✕";
    rm.addEventListener("click", () => removeImage(item.id));
    cell.append(img, rm);
    thumbs.appendChild(cell);
  }

  async function addImage(blob, filename) {
    if (pool.length >= MAX_ATTACHMENTS) {
      toast("一条笔记最多 " + MAX_ATTACHMENTS + " 张图片", true);
      return false;
    }
    const item = { id: uid(), ts: Date.now(), dataUrl: await readAsDataUrl(blob), type: blob.type, filename };
    pool.push(item);
    appendThumb(item);
    setRowVisible(thumbs, true);
    thumbs.scrollLeft = thumbs.scrollWidth;
    await persistImage(item);
    return true;
  }

  function removeImage(id) {
    const idx = pool.findIndex((it) => it.id === id);
    if (idx === -1) return;
    pool.splice(idx, 1);
    const cell = thumbs.querySelector('[data-id="' + id + '"]');
    if (cell) cell.remove();
    setRowVisible(thumbs, pool.length > 0);
    forgetImage(id);
    // × 按钮随缩略图移除后焦点落回页面，交还编辑框，继续 Ctrl+V 仍能进图片池
    editor.focus();
  }

  // 单张图片落本地（关掉编辑器再开还能接着写；后台上传时也按这个键回读）。
  // dataUrl 体积大，只在增删/上传状态变化时写，不随正文草稿重写
  async function persistImage(item) {
    try {
      await persist({
        [pageImageKey(item.id)]: {
          dataUrl: item.dataUrl,
          type: item.type,
          filename: item.filename,
          ts: item.ts,
          resourceId: item.resourceId,
        },
      });
    } catch (err) {
      // 写失败（配额等）：本次会话仍能保存，但关掉编辑器后这张图不再保留、也无法上传
      console.warn("cflow: 图片草稿写入失败", err);
      toast("图片写入本地失败，请移除后重新添加", true);
    }
  }

  function forgetImage(id) {
    chrome.storage.local.remove(pageImageKey(id)).catch(() => {});
  }

  async function restoreImages() {
    const data = await chrome.storage.local.get(null);
    pool = Object.keys(data || {})
      .filter((k) => k.startsWith(PAGE_IMAGE_KEY_PREFIX))
      .map((k) => ({ id: k.slice(PAGE_IMAGE_KEY_PREFIX.length), ...data[k] }))
      .filter((it) => typeof it.dataUrl === "string" && it.dataUrl.startsWith("data:image/"))
      .sort((a, b) => (a.ts || 0) - (b.ts || 0))
      .slice(0, MAX_ATTACHMENTS)
      .map((it) => ({
        id: it.id,
        ts: it.ts,
        dataUrl: it.dataUrl,
        type: it.type || "",
        filename: it.filename || "image",
        resourceId: Number.isInteger(it.resourceId) ? it.resourceId : undefined,
      }));
    for (const item of pool) appendThumb(item);
    setRowVisible(thumbs, pool.length > 0);
  }

  // 剪贴板里有图片（截图、复制的图）时 Ctrl+V 进图片池而不进编辑框；纯文本粘贴照常放行
  root.addEventListener("paste", (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items || saving) return;
    const files = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (!files.length) return;
    e.preventDefault();
    // 不让网页自己的 paste 监听读到剪贴板
    e.stopPropagation();
    (async () => {
      try {
        for (const f of files) {
          // 截图/复制的网页图没有有意义的文件名（Chrome 一律叫 image.png），补上时间
          const name = f.name && !/^image\.\w+$/i.test(f.name) ? f.name : "截图 " + fileStamp() + "." + imageExt(f.type);
          if (!(await addImage(f, name))) break;
        }
      } catch (err) {
        toast(err.message || "图片读取失败", true);
      }
    })();
  });

  /* ---------- 保存 ---------- */

  // 包装 sendMessage：后台异常/断连统一成 { ok: false, error }
  function send(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (resp) => {
        if (chrome.runtime.lastError) resp = { ok: false, error: chrome.runtime.lastError.message };
        resolve(resp || { ok: false, error: "后台无响应，请重试" });
      });
    });
  }

  function setSaving(on) {
    saving = on;
    root.classList.toggle("saving", on);
    saveBtn.disabled = on;
    // 上传期间锁住会改动正文/图片池的入口；空间下拉不动（currentSpaceId 把 disabled 当作「没选中」）
    linkBtn.disabled = on;
    videoBtn.disabled = on;
    snapBtn.disabled = on;
  }

  async function save() {
    if (saving) return;
    let content = editor.value.trim();
    // 带图片时正文可以为空（与安卓端一致）
    if (!content && !pool.length) {
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

    setSaving(true);
    // 上传期间增删图片不影响本次提交
    const items = pool.slice();
    try {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.resourceId != null) continue;
        saveBtn.textContent = "上传图片 " + (i + 1) + "/" + items.length + "…";
        const resp = await send({ type: "uploadResource", imageId: item.id });
        if (!resp || !resp.ok || !Number.isInteger(resp.id)) throw new Error((resp && resp.error) || "图片上传失败，请重试");
        item.resourceId = resp.id;
        persistImage(item); // 已传 id 落草稿：建笔记失败重试时不重传
      }
      saveBtn.textContent = "保存中…";
      const resp = await send({ type: "createMemo", spaceId, content, resourceIdList: items.map((it) => it.resourceId) });
      if (!resp || !resp.ok) throw new Error((resp && resp.error) || "保存失败，请重试");
      state.lastSpaceId = spaceId;
      pool = [];
      thumbs.textContent = "";
      setRowVisible(thumbs, false);
      editor.value = "";
      // 草稿清理失败不影响已保存的结果
      persist({ [PAGE_DRAFT_KEY]: null }).catch(() => {});
      items.forEach((it) => forgetImage(it.id));
      toast("已保存 ✓");
    } catch (err) {
      console.warn("cflow: 保存失败", err);
      // 后台被 Chrome 回收时 sendMessage 只给得出这句英文，换成用户看得懂的说法
      const msg = /message port closed/i.test(err.message || "") ? "与后台的连接中断，请重试" : err.message;
      toast(msg || "保存失败，请重试", true);
    } finally {
      setSaving(false);
      saveBtn.textContent = "保存";
    }
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
