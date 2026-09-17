"use strict";

// 页面内摘录选择层：与 common.js 注入到同一隔离世界，直接使用其全局
// （state/loadSettings/renderSpaceList/markSaved/toast/buildSelectionContent 等）。

(async function () {
  const OLD = document.getElementById("cflow-overlay");
  if (OLD) OLD.remove();

  await loadSettings();
  const { pendingCapture } = await chrome.storage.session.get("pendingCapture");
  const capture = pendingCapture || {};

  /* ---------- 构建 DOM ---------- */

  const root = document.createElement("div");
  root.id = "cflow-overlay";
  root.className = "cflow-overlay";
  root.lang = "zh-CN";

  const dialog = document.createElement("div");
  dialog.className = "cflow-dialog";

  // 顶栏
  const topbar = document.createElement("div");
  topbar.className = "cflow-topbar";
  const brand = document.createElement("div");
  brand.className = "cflow-brand";
  const brandIcon = document.createElement("span");
  brandIcon.textContent = "🌿";
  const brandText = document.createElement("span");
  brandText.textContent = "发送到 cflow 笔记";
  brand.append(brandIcon, brandText);
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "cflow-close";
  closeBtn.title = "关闭 (Esc)";
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", close);
  topbar.append(brand, closeBtn);

  dialog.appendChild(topbar);

  if (!isConfigured()) {
    const tip = document.createElement("div");
    tip.className = "list-empty";
    tip.textContent = "尚未配置，请先点击浏览器工具栏的 cflow 图标完成设置";
    dialog.appendChild(tip);
  } else {
    // 来源卡片
    const pageCard = document.createElement("div");
    pageCard.className = "page-card";
    if (capture.favicon) {
      const fav = document.createElement("img");
      fav.className = "favicon";
      fav.src = capture.favicon;
      fav.onerror = () => fav.remove();
      pageCard.appendChild(fav);
    }
    const pageMeta = document.createElement("div");
    pageMeta.className = "page-meta";
    const pageTitle = document.createElement("div");
    pageTitle.className = "page-title";
    pageTitle.textContent = capture.title || capture.url || "未知页面";
    const pageUrl = document.createElement("div");
    pageUrl.className = "page-url";
    pageUrl.textContent = capture.url || "";
    pageMeta.append(pageTitle, pageUrl);
    pageCard.appendChild(pageMeta);
    dialog.appendChild(pageCard);

    // 选中内容预览
    if (capture.text) {
      const quote = document.createElement("div");
      quote.className = "quote-card";
      const quoteText = document.createElement("div");
      quoteText.className = "quote-text";
      quoteText.textContent = capture.text;
      quote.appendChild(quoteText);
      dialog.appendChild(quote);
    }

    // 空间列表
    const label = document.createElement("div");
    label.className = "section-label";
    label.textContent = "保存到空间";
    const list = document.createElement("div");
    list.className = "space-list";
    dialog.append(label, list);
    renderSpaceList(list, onPick, "暂无可用空间，请到插件设置里检查 Token 权限");
  }

  // toast 元素（common.js 的 toast() 依赖此 id）
  const toastEl = document.createElement("div");
  toastEl.id = "cflow-toast";
  toastEl.className = "toast";
  toastEl.hidden = true;
  dialog.appendChild(toastEl);

  root.appendChild(dialog);
  root.addEventListener("mousedown", (e) => {
    if (e.target === root) close();
  });
  document.documentElement.appendChild(root);

  function close() {
    root.remove();
    document.removeEventListener("keydown", onKeydown);
  }

  function onKeydown(e) {
    if (e.key === "Escape") close();
  }
  document.addEventListener("keydown", onKeydown);

  /* ---------- 保存 ---------- */

  let saving = false;

  function onPick(space, btn) {
    if (saving) return;
    saving = true;
    setSpaceListSaving(true);
    const nameEl = btn.querySelector(".space-name");
    if (nameEl) nameEl.textContent = "保存中…";

    let content;
    try {
      content = buildSelectionContent(capture);
    } catch (err) {
      toast(err.message, true);
      saving = false;
      setSpaceListSaving(false);
      return;
    }

    // 页面上下文受 CORS 限制，创建笔记由 background 代理
    chrome.runtime.sendMessage(
      {
        type: "createMemo",
        spaceId: space.spaceId,
        content,
      },
      (resp) => {
        if (chrome.runtime.lastError) {
          resp = { ok: false, error: chrome.runtime.lastError.message };
        }
        if (resp && resp.ok) {
          state.lastSpaceId = space.spaceId;
          markSaved(btn);
          setTimeout(close, 700);
        } else {
          toast((resp && resp.error) || "保存失败，请重试", true);
          saving = false;
          setSpaceListSaving(false);
        }
      }
    );
  }
})();
