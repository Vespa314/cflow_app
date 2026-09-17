"use strict";

// 右键菜单：把网页选中文字发送到 cflow 笔记，在页面内弹出居中的悬浮选择层。

importScripts("common.js");

const MENU_ID = "send-to-cflow";

// 页面悬浮层（非受信上下文）需要读取 storage.session 中的选中内容
chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" });

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" });
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "发送到 cflow 笔记",
      contexts: ["selection"],
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab || tab.id == null) return;

  const capture = {
    text: info.selectionText || "",
    url: info.pageUrl || tab.url || "",
    title: tab.title || "",
    favicon: tab.favicon || tab.favIconUrl || "",
  };
  await chrome.storage.session.set({ pendingCapture: capture });

  // activeTab 授权当前页：点击右键菜单项即可注入，无需常驻任意站点权限
  try {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["overlay/overlay.css"] });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["common.js", "overlay/overlay.js"],
    });
  } catch (err) {
    console.warn("cflow: 无法在此页面注入摘录面板", err);
  }
});

// 悬浮层运行在页面上下文里受 CORS 限制，创建笔记统一由后台代理
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "createMemo") return undefined;
  (async () => {
    await loadSettings();
    try {
      await api("/api/v1/memo", {
        method: "POST",
        body: JSON.stringify({
          content: msg.content,
          secretLv: 0, // 固定发普通（非敏感）等级，不跟随空间默认
          resourceIdList: [],
          spaceId: msg.spaceId,
        }),
      });
      await persist({ lastSpaceId: msg.spaceId });
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ ok: false, error: describeError(err) });
    }
  })();
  return true; // 异步 sendResponse
});
