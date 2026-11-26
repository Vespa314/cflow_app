"use strict";

// 右键菜单：
// - 选中文字「发送到 cflow 笔记」→ 页面内弹出居中的悬浮选择层
// - 页面任意处「cflow笔记模式」→ 页面内弹出可拖拽缩放的浮动编辑器
//   （工具栏弹窗顶栏「记笔记模式」走同一条注入）

importScripts("common.js");

const MENU_ID = "send-to-cflow";
const NOTE_MENU_ID = "cflow-note";

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
    chrome.contextMenus.create({
      id: NOTE_MENU_ID,
      title: "cflow笔记模式",
      contexts: ["page"],
    });
  });
});

// activeTab 授权当前页：点击右键菜单项即可注入，无需常驻任意站点权限。
// 同页多次注入不重复插样式：入口脚本会打 __cflowOverlayReady 标记（页面跳转后标记消失，自然重插）
async function injectOverlay(tabId, entryFiles) {
  let cssInjected = false;
  try {
    const [probe] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => Boolean(window.__cflowOverlayReady),
    });
    cssInjected = Boolean(probe && probe.result);
  } catch (e) {
    cssInjected = false;
  }
  if (!cssInjected) {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["overlay/overlay.css"] });
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["common.js", ...entryFiles],
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || tab.id == null) return;

  if (info.menuItemId === MENU_ID) {
    const capture = {
      text: info.selectionText || "",
      url: info.pageUrl || tab.url || "",
      title: tab.title || "",
      favicon: tab.favIconUrl || "",
    };
    await chrome.storage.session.set({ pendingCapture: capture });
    try {
      await injectOverlay(tab.id, ["overlay/overlay.js"]);
    } catch (err) {
      console.warn("cflow: 无法在此页面注入摘录面板", err);
    }
    return;
  }

  if (info.menuItemId === NOTE_MENU_ID) {
    try {
      await openPageNote(tab.id);
    } catch (err) {
      // 右键路径没有弹窗可展示错误，openPageNote 已打日志
    }
  }
});

// 右键「cflow笔记模式」与工具栏弹窗「记笔记模式」共用这一条注入
async function openPageNote(tabId) {
  if (tabId == null) throw new Error("无法读取当前页面");
  try {
    await injectOverlay(tabId, ["overlay/note.js"]);
  } catch (err) {
    console.warn("cflow: 无法在此页面注入笔记编辑器", err);
    throw new Error("这个页面不支持记笔记，请换一个普通网页");
  }
}

// 悬浮层运行在页面上下文里受 CORS 限制，网络请求与标签页截图统一由后台代理
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return undefined;

  if (msg.type === "openNoteMode") {
    (async () => {
      try {
        await openPageNote(msg.tabId);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || "打开失败" });
      }
    })();
    return true;
  }

  if (msg.type === "createMemo") {
    (async () => {
      try {
        // loadSettings 也放进 try：其异常若发生在 sendResponse 之前，调用方会永久等待
        await loadSettings();
        // 附件 id 只认本扩展后台（下方 uploadResource）签发的整数，其余一律丢弃：页面上下文可伪造消息
        const resourceIdList = (Array.isArray(msg.resourceIdList) ? msg.resourceIdList : []).filter((id) =>
          Number.isInteger(id)
        );
        const _payload = buildMemoIdemPayload(msg.content, resourceIdList, msg.spaceId, 0);
        await api("/api/v1/memo", {
          method: "POST",
          headers: { "Idempotency-Key": memoIdemKeyFor(_payload) },
          body: JSON.stringify({
            content: msg.content,
            secretLv: 0, // 固定发普通（非敏感）等级，不跟随空间默认
            resourceIdList,
            spaceId: msg.spaceId,
          }),
        });
        resetMemoIdem();
        await persist({ lastSpaceId: msg.spaceId });
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: describeError(err) });
      }
    })();
    return true; // 异步 sendResponse
  }

  if (msg.type === "getSpaces") {
    (async () => {
      try {
        await loadSettings();
        if (!isConfigured()) throw new Error("尚未配置，请先点击浏览器工具栏的 cflow 图标完成设置");
        // 页面上下文无法自行 fetch（CORS）：缓存为空时由后台拉一次
        if (!state.spaces.length) await fetchSpaces();
        sendResponse({ ok: true, spaces: state.spaces, lastSpaceId: state.lastSpaceId });
      } catch (err) {
        sendResponse({ ok: false, error: describeError(err) });
      }
    })();
    return true;
  }

  if (msg.type === "getTags") {
    (async () => {
      try {
        await loadSettings();
        if (!isConfigured()) throw new Error("尚未配置，请先点击浏览器工具栏的 cflow 图标完成设置");
        // fetchTags 自带每空间会话级缓存（common.js）
        const tags = await fetchTags(msg.spaceId || "");
        sendResponse({ ok: true, tags });
      } catch (err) {
        sendResponse({ ok: false, error: describeError(err) });
      }
    })();
    return true;
  }

  if (msg.type === "uploadResource") {
    (async () => {
      // 上传可能很慢（大图 + 慢上行）：fetch 不算后台的「活动」，超过 30 秒没有事件/扩展 API 调用
      // 后台就会被 Chrome 回收，消息端口随之关闭（The message port closed before a response was
      // received）。期间定时调一次扩展 API 重置空闲计时，见 Chrome 文档「Idle and shutdown」。
      const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
      const key = pageImageKey(String(msg.imageId || ""));
      try {
        await loadSettings();
        if (!isConfigured()) throw new Error("尚未配置，请先点击浏览器工具栏的 cflow 图标完成设置");
        // 图片数据由页内编辑器预先写入 storage，这里按 id 回读（不经消息通道）
        const stored = await chrome.storage.local.get(key);
        const image = stored[key];
        if (!image || typeof image.dataUrl !== "string" || !image.dataUrl.startsWith("data:image/")) {
          throw new Error("图片数据已失效，请移除后重新添加");
        }
        console.log("cflow: upload start", image.filename, Math.round(image.dataUrl.length / 1024) + "KB");
        const startedAt = Date.now();
        const resource = await uploadResource(image.dataUrl, image.filename || "image", image.type || "");
        if (!resource || !Number.isInteger(resource.id)) throw new Error("上传响应异常，请重试");
        console.log("cflow: upload done", resource.id, Date.now() - startedAt + "ms");
        sendResponse({ ok: true, id: resource.id });
      } catch (err) {
        console.warn("cflow: upload failed", err);
        sendResponse({ ok: false, error: describeError(err) });
      } finally {
        clearInterval(keepAlive);
      }
    })();
    return true;
  }

  // 视频帧截取的兜底：跨域视频画布被污染时改截标签页可见区域（需 activeTab 授权，
  // 右键菜单/工具栏弹窗打开笔记模式时已授予）
  if (msg.type === "captureTab") {
    (async () => {
      try {
        if (!sender.tab || sender.tab.id == null) throw new Error("无法读取当前页面");
        const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.id, { format: "png" });
        sendResponse({ ok: true, dataUrl });
      } catch (err) {
        sendResponse({ ok: false, error: "截图失败：" + (err.message || "当前页面不允许截图") });
      }
    })();
    return true;
  }

  return undefined;
});
