"use strict";

// 工具栏弹窗：一键把当前网址保存到所选空间。公共逻辑见 common.js。

const popupState = {
  tab: null,
  saving: false,
};

/* ---------- 当前页面卡片 ---------- */

function renderPageCard() {
  const { url, title } = popupState.tab || {};
  document.getElementById("page-title").textContent = title || url || "无法读取当前页面";
  document.getElementById("page-url").textContent = url || "";
  const fav = document.getElementById("page-favicon");
  const fallback = document.getElementById("page-favicon-fallback");
  if (popupState.tab && popupState.tab.favIconUrl) {
    fav.hidden = false;
    fallback.hidden = true;
    fav.onerror = () => {
      fav.hidden = true;
      fallback.hidden = false;
    };
    fav.src = popupState.tab.favIconUrl;
  } else {
    fav.hidden = true;
    fallback.hidden = false;
  }
}

/* ---------- 保存当前网址 ---------- */

function buildContent() {
  const { url } = popupState.tab || {};
  if (!url) throw new Error("无法读取当前页面地址");
  return url;
}

async function saveToSpace(space, btn) {
  if (popupState.saving) return;
  popupState.saving = true;
  setSpaceListSaving(true);
  try {
    await api("/api/v1/memo", {
      method: "POST",
      body: JSON.stringify({
        content: buildContent(),
        secretLv: 0, // 固定发普通（非敏感）等级，不跟随空间默认
        resourceIdList: [],
        spaceId: space.spaceId,
      }),
    });
    state.lastSpaceId = space.spaceId;
    await persist({ lastSpaceId: space.spaceId });
    markSaved(btn);
    setTimeout(() => window.close(), 800);
  } catch (err) {
    toast(describeError(err), true);
    setSpaceListSaving(false);
    popupState.saving = false;
  }
}

/* ---------- 页内记笔记模式（与右键「cflow笔记模式」同一套浮动编辑器） ---------- */

function syncNoteModeBtn() {
  document.getElementById("btn-note-mode").hidden = !isConfigured();
}

async function openNoteMode() {
  const tabId = popupState.tab && popupState.tab.id;
  const btn = document.getElementById("btn-note-mode");
  if (tabId == null) {
    toast("无法读取当前页面", true);
    return;
  }
  btn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: "openNoteMode", tabId });
    if (!res || !res.ok) throw new Error((res && res.error) || "打开失败");
    window.close();
  } catch (err) {
    toast(err.message || "这个页面不支持记笔记，请换一个普通网页", true);
    btn.disabled = false;
  }
}

/* ---------- 记笔记 ---------- */

const DRAFT_KEY = NOTE_DRAFT_KEY; // 键名统一在 common.js 维护
let noteSaving = false;
let draftTimer = null;

function noteEditor() {
  return document.getElementById("note-editor");
}

function noteSpaceSelect() {
  return document.getElementById("note-space");
}

// 重建笔记目标空间下拉，尽量保留当前选中项
function syncNoteSpaces() {
  const select = noteSpaceSelect();
  const prev = select.value;
  select.textContent = "";
  if (!state.spaces.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "暂无空间";
    select.appendChild(opt);
    select.disabled = true;
    return;
  }
  select.disabled = false;
  for (const space of orderedSpaces()) {
    const opt = document.createElement("option");
    opt.value = space.spaceId;
    opt.textContent = spaceDisplayName(space);
    select.appendChild(opt);
  }
  if ([...select.options].some((o) => o.value === prev)) select.value = prev;
}

function updateSendBtnState() {
  document.getElementById("btn-send-note").disabled = noteSaving || !noteEditor().value.trim();
}

function showDraftHint(updatedAt) {
  const hint = document.getElementById("note-draft-hint");
  const time = updatedAt ? new Date(updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  hint.textContent = "草稿已自动保存到本地" + (time ? " · " + time : "");
  hint.hidden = false;
}

function hideDraftHint() {
  document.getElementById("note-draft-hint").hidden = true;
}

// 编辑内容变动即本地存草稿，发送成功后才清空；再次打开面板可接着写
async function saveDraft() {
  const content = noteEditor().value;
  if (!content.trim()) {
    await persist({ [DRAFT_KEY]: null });
    hideDraftHint();
    return;
  }
  await persist({ [DRAFT_KEY]: { content, spaceId: noteSpaceSelect().value, updatedAt: Date.now() } });
  showDraftHint(Date.now());
}

async function restoreDraft() {
  const data = await chrome.storage.local.get(DRAFT_KEY);
  const draft = data && data[DRAFT_KEY];
  if (draft && typeof draft.content === "string" && draft.content) {
    noteEditor().value = draft.content;
    const select = noteSpaceSelect();
    if (draft.spaceId != null && [...select.options].some((o) => o.value === draft.spaceId)) {
      select.value = draft.spaceId;
    }
    showDraftHint(draft.updatedAt);
  }
  updateSendBtnState();
}

async function sendNote() {
  if (noteSaving) return;
  let content = noteEditor().value.trim();
  if (!content) {
    toast("先写点内容再发送吧", true);
    return;
  }
  // 按字节判定（common.js 同款注释）：中文按 UTF-16 长度判会漏放大约 3 倍的量
  if (new TextEncoder().encode(content).length > MAX_TEXT_LENGTH) content = truncateUtf8Bytes(content, MAX_TEXT_LENGTH);
  const spaceId = noteSpaceSelect().value;

  noteSaving = true;
  const btn = document.getElementById("btn-send-note");
  btn.disabled = true;
  btn.textContent = "发送中…";
  try {
    await api("/api/v1/memo", {
      method: "POST",
      body: JSON.stringify({
        content,
        secretLv: 0, // 与转发一致，固定发普通（非敏感）等级
        resourceIdList: [],
        spaceId,
      }),
    });
    state.lastSpaceId = spaceId;
    await persist({ lastSpaceId: spaceId, [DRAFT_KEY]: null });
    noteEditor().value = "";
    hideDraftHint();
    toast("已发送 ✓");
    setTimeout(() => window.close(), 800);
  } catch (err) {
    toast(describeError(err), true);
    noteSaving = false;
    btn.textContent = "发送";
    updateSendBtnState();
  }
}

/* ---------- 设置 ---------- */

function showSettingsError(msg) {
  const box = document.getElementById("settings-error");
  box.textContent = msg;
  box.hidden = false;
}

async function saveSettings() {
  const token = document.getElementById("input-token").value.trim();
  document.getElementById("settings-error").hidden = true;
  if (!token) {
    showSettingsError("请填写 API Token");
    return;
  }

  const btn = document.getElementById("btn-save");
  btn.disabled = true;
  document.getElementById("btn-save-text").textContent = "正在连接…";
  try {
    if (!(await requestHostPermission(DEFAULT_SERVER))) {
      throw new Error("未授予访问服务器的权限，请重试并允许");
    }
    const accountChanged = state.token !== token;
    state.token = token;
    await fetchSpaces();
    await persist({ token });
    if (accountChanged) {
      // 换账号（token 变化）时清掉旧账号的本地草稿（面板 + 页内编辑器），避免下一个账号看到
      await clearDrafts();
      noteEditor().value = "";
      hideDraftHint();
      updateSendBtnState();
    }
    renderSpaceList(document.getElementById("space-list"), saveToSpace);
    syncNoteSpaces();
    syncNoteModeBtn();
    showView("main");
    toast("已连接，拉取到 " + state.spaces.length + " 个空间");
  } catch (err) {
    showSettingsError(describeError(err));
  } finally {
    btn.disabled = false;
    document.getElementById("btn-save-text").textContent = "测试连接并保存";
  }
}

/* ---------- 扫码登录（设置页内嵌二维码） ---------- */

// 与登录页 QrLoginPanel 同一组 pairing/web/* 接口：client=extension，approved 后
// 服务端签发描述「浏览器插件」的 access token（而非登录 cookie），凭 nonce 一次性领取。
// popup 关闭轮询即停、会话 5 分钟后自然过期，重开点刷新即可，无需独立窗口。

const QR_POLL_INTERVAL = 1500;
// 会话代次：刷新二维码/返回后旧轮询全部作废
let qrGen = 0;
let qrTimer = null;
// 仅扫码流程产生的 token 落库才触发下面的 storage.onChanged 视图切换
// （手动保存也会写 token，不加以区分会误弹「扫码登录成功」）
let qrScanning = false;

function qrEls() {
  return {
    pane: document.getElementById("qr-login-pane"),
    form: document.getElementById("settings-form"),
    canvas: document.getElementById("qr-canvas"),
    mask: document.getElementById("qr-expired-mask"),
    status: document.getElementById("qr-status"),
    refresh: document.getElementById("btn-refresh-qr"),
  };
}

// 按设备像素比出图，保证高分屏上模块边界清晰
function drawQr(text) {
  const cssSize = 184;
  const dpr = window.devicePixelRatio || 1;
  const qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM);
  const scale = Math.max(1, Math.floor((cssSize * dpr) / qr.size));
  const dim = qr.size * scale;
  const canvas = qrEls().canvas;
  canvas.width = dim;
  canvas.height = dim;
  canvas.style.width = cssSize + "px";
  canvas.style.height = cssSize + "px";
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, dim, dim);
  ctx.fillStyle = "#1c1c1e";
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.getModule(x, y)) ctx.fillRect(x * scale, y * scale, scale, scale);
    }
  }
}

function qrFail(msg) {
  const el = qrEls();
  el.status.textContent = msg;
  el.refresh.hidden = false;
}

async function startQrLogin() {
  const gen = ++qrGen;
  clearTimeout(qrTimer);
  const el = qrEls();
  el.mask.hidden = true;
  el.refresh.hidden = true;
  el.status.textContent = "正在生成二维码…";
  let data;
  try {
    data = await api("/api/v1/pairing/web/start", {
      method: "POST",
      // origin 修正反代丢 X-Forwarded-Proto 时二维码退化成 http（服务端校验 host 一致才采纳）
      body: JSON.stringify({ client: "extension", origin: DEFAULT_SERVER }),
    });
  } catch (err) {
    qrFail(describeError(err));
    return;
  }
  if (gen !== qrGen) return;
  try {
    drawQr(data.qr_content);
  } catch (err) {
    qrFail("二维码生成失败：" + err.message);
    return;
  }
  el.status.textContent = "打开手机 cflow APP「扫一扫」扫描二维码";
  pollQr(gen, data.session_id, data.nonce);
}

function pollQr(gen, sessionId, nonce) {
  qrTimer = setTimeout(async () => {
    if (gen !== qrGen) return;
    let data;
    try {
      data = await api("/api/v1/pairing/web/status?session_id=" + encodeURIComponent(sessionId) + "&nonce=" + encodeURIComponent(nonce));
    } catch (err) {
      // 网络抖动不直接判死，下一轮重试；连续失败自然拖到会话过期
      qrEls().status.textContent = describeError(err);
      pollQr(gen, sessionId, nonce);
      return;
    }
    if (gen !== qrGen) return;
    if (data && data.token) {
      await finishQrLogin(data);
      return;
    }
    const status = data && data.status;
    if (status === "scanned") {
      qrEls().status.textContent = (data.device_name || "手机") + " 已扫码，请在手机上确认登录";
    } else if (status === "expired") {
      qrEls().mask.hidden = false;
      qrFail("二维码已过期");
      return;
    } else if (status !== "wait") {
      qrFail(status === "denied" ? "手机端拒绝了本次登录" : "登录状态异常，请刷新重试");
      return;
    }
    pollQr(gen, sessionId, nonce);
  }, QR_POLL_INTERVAL);
}

async function finishQrLogin(data) {
  qrGen++;
  clearTimeout(qrTimer);
  qrEls().status.textContent = "登录成功，正在拉取空间列表…";
  state.token = data.token;
  try {
    await fetchSpaces();
  } catch (err) {
    console.warn("cflow: 拉取空间失败", err);
  }
  // token 落库触发 storage.onChanged（qrScanning 分支）完成切视图与提示
  await persist({ token: state.token });
}

function resetQrPane() {
  qrGen++;
  clearTimeout(qrTimer);
  qrScanning = false;
  const el = qrEls();
  el.pane.classList.add("hidden");
  el.form.classList.remove("hidden");
  el.mask.hidden = true;
  el.refresh.hidden = true;
}

async function openQrLogin() {
  try {
    if (!(await requestHostPermission(DEFAULT_SERVER))) {
      throw new Error("未授予访问 cflow.cc 的权限，请重试并允许");
    }
  } catch (err) {
    toast(err.message || "权限授予失败", true);
    return;
  }
  const el = qrEls();
  el.form.classList.add("hidden");
  el.pane.classList.remove("hidden");
  qrScanning = true;
  await startQrLogin();
}

/* ---------- 刷新空间列表 ---------- */

async function refreshSpaces(silent) {
  if (!isConfigured()) return;
  const btn = document.getElementById("btn-refresh");
  if (!silent) btn.classList.add("spin");
  try {
    await fetchSpaces();
    renderSpaceList(document.getElementById("space-list"), saveToSpace);
    syncNoteSpaces();
    if (!silent) toast("空间列表已更新");
  } catch (err) {
    if (!silent) toast(describeError(err), true);
  } finally {
    btn.classList.remove("spin");
  }
}

/* ---------- 标签页切换 ---------- */

function showTab(name) {
  const isForward = name === "forward";
  document.getElementById("pane-forward").classList.toggle("hidden", !isForward);
  document.getElementById("pane-note").classList.toggle("hidden", isForward);
  document.getElementById("tab-forward").classList.toggle("active", isForward);
  document.getElementById("tab-note").classList.toggle("active", !isForward);
  document.getElementById("tab-forward").setAttribute("aria-selected", String(isForward));
  document.getElementById("tab-note").setAttribute("aria-selected", String(!isForward));
  if (!isForward) {
    const editor = noteEditor();
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }
}

/* ---------- 视图 ---------- */

function showView(name) {
  document.getElementById("view-main").classList.toggle("hidden", name !== "main");
  document.getElementById("view-settings").classList.toggle("hidden", name !== "settings");
}

/* ---------- 入口 ---------- */

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  popupState.tab = tab || {};
  renderPageCard();

  await loadSettings();
  document.getElementById("input-token").value = state.token;
  renderSpaceList(document.getElementById("space-list"), saveToSpace);
  syncNoteSpaces();
  syncNoteModeBtn();
  await restoreDraft();
  showView(isConfigured() ? "main" : "settings");

  // 已有配置时静默刷新一次，保持空间列表不过期
  if (isConfigured()) refreshSpaces(true);

  document.getElementById("btn-settings").addEventListener("click", () => showView("settings"));
  document.getElementById("btn-note-mode").addEventListener("click", openNoteMode);
  document.getElementById("btn-refresh").addEventListener("click", () => refreshSpaces(false));
  document.getElementById("btn-save").addEventListener("click", saveSettings);
  document.getElementById("btn-qr-login").addEventListener("click", openQrLogin);
  document.getElementById("btn-refresh-qr").addEventListener("click", startQrLogin);
  document.getElementById("btn-qr-back").addEventListener("click", resetQrPane);
  document.getElementById("input-token").addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveSettings();
  });
  document.getElementById("tab-forward").addEventListener("click", () => showTab("forward"));
  document.getElementById("tab-note").addEventListener("click", () => showTab("note"));
  document.getElementById("btn-send-note").addEventListener("click", sendNote);
  const editor = noteEditor();
  editor.addEventListener("input", () => {
    updateSendBtnState();
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, 400);
  });
  editor.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") sendNote();
  });
  // # 标签联想：候选按当前所选空间拉取（fetchTags 自带会话级缓存）
  attachTagSuggest(editor, async () => {
    if (!isConfigured()) throw new Error("未配置");
    return fetchTags(noteSpaceSelect().value);
  });
  // 放在标签联想之后：候选打开时 Tab/Enter 已被占用
  attachListEditing(editor);

  // 扫码登录成功（token 落库）→ 切主视图；qrScanning 区分手动保存，避免误弹成功提示
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local" || !changes.token || !changes.token.newValue || !qrScanning) return;
    await loadSettings();
    document.getElementById("input-token").value = state.token;
    renderSpaceList(document.getElementById("space-list"), saveToSpace);
    syncNoteSpaces();
    resetQrPane();
    syncNoteModeBtn();
    await clearDrafts();
    noteEditor().value = "";
    hideDraftHint();
    updateSendBtnState();
    showView("main");
    toast("扫码登录成功");
  });
}

document.addEventListener("DOMContentLoaded", init);
