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

/* ---------- 记笔记 ---------- */

const DRAFT_KEY = "noteDraft";
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
  if (content.length > MAX_TEXT_LENGTH) content = content.slice(0, MAX_TEXT_LENGTH) + "…";
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
  const server = normalizeServer(document.getElementById("input-server").value);
  const token = document.getElementById("input-token").value.trim();
  document.getElementById("settings-error").hidden = true;
  if (!server || !token) {
    showSettingsError("请填写服务地址和 API Token");
    return;
  }
  try {
    new URL(server);
  } catch {
    showSettingsError("服务地址格式不正确");
    return;
  }

  const btn = document.getElementById("btn-save");
  btn.disabled = true;
  document.getElementById("btn-save-text").textContent = "正在连接…";
  try {
    if (!(await requestHostPermission(server))) {
      throw new Error("未授予访问服务器的权限，请重试并允许");
    }
    const accountChanged = state.server !== server || state.token !== token;
    state.server = server;
    state.token = token;
    await fetchSpaces();
    await persist({ server, token });
    if (accountChanged) {
      // 换账号（server/token 变化）时清掉旧账号的本地草稿，避免下一个账号看到
      await persist({ [DRAFT_KEY]: null });
      noteEditor().value = "";
      hideDraftHint();
      updateSendBtnState();
    }
    renderSpaceList(document.getElementById("space-list"), saveToSpace);
    syncNoteSpaces();
    showView("main");
    toast("已连接，拉取到 " + state.spaces.length + " 个空间");
  } catch (err) {
    showSettingsError(describeError(err));
  } finally {
    btn.disabled = false;
    document.getElementById("btn-save-text").textContent = "测试连接并保存";
  }
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
  document.getElementById("input-server").value = state.server || DEFAULT_SERVER;
  document.getElementById("input-token").value = state.token;
  renderSpaceList(document.getElementById("space-list"), saveToSpace);
  syncNoteSpaces();
  await restoreDraft();
  showView(isConfigured() ? "main" : "settings");

  // 已有配置时静默刷新一次，保持空间列表不过期
  if (isConfigured()) refreshSpaces(true);

  document.getElementById("btn-settings").addEventListener("click", () => showView("settings"));
  document.getElementById("btn-refresh").addEventListener("click", () => refreshSpaces(false));
  document.getElementById("btn-save").addEventListener("click", saveSettings);
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
}

document.addEventListener("DOMContentLoaded", init);
