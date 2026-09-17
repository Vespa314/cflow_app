"use strict";

// popup 与页面悬浮层（overlay）共用的配置、API 与空间列表逻辑，统一在此维护。
// 注意：本文件也会注入到 service worker（background.js）与页面（overlay），
// 顶层不能出现 DOM 或 window 专属调用。

const DEFAULT_SPACE_NAME = "默认空间";
const DEFAULT_SERVER = "https://cflow.cc";
// 后端 api/v1/memo.go 的 maxContentLength 为 65535 字节，留出余量截断
const MAX_TEXT_LENGTH = 60000;

const state = {
  server: "",
  token: "",
  spaces: [],
  lastSpaceId: null,
};

/* ---------- 本地存储 ---------- */

async function loadSettings() {
  const data = await chrome.storage.local.get(["server", "token", "spaces", "lastSpaceId"]);
  state.server = data.server || "";
  state.token = data.token || "";
  state.spaces = Array.isArray(data.spaces) ? data.spaces : [];
  state.lastSpaceId = data.lastSpaceId ?? null;
}

function persist(patch) {
  return chrome.storage.local.set(patch);
}

function isConfigured() {
  return !!(state.server && state.token);
}

/* ---------- API ---------- */

function normalizeServer(raw) {
  let s = (raw || "").trim().replace(/\/+$/, "");
  if (s && !/^https?:\/\//i.test(s)) s = "https://" + s;
  return s;
}

async function requestHostPermission(server) {
  let origin;
  try {
    origin = new URL(server).origin;
  } catch {
    return false;
  }
  const origins = [origin + "/*"];
  if (await chrome.permissions.contains({ origins })) return true;
  return chrome.permissions.request({ origins });
}

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(state.server + path, {
      ...options,
      headers: {
        Authorization: "Bearer " + state.token,
        "Content-Type": "application/json",
      },
    });
  } catch {
    const err = new Error("无法连接服务器，请检查服务地址");
    err.network = true;
    throw err;
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* 无 JSON body */
  }
  if (!res.ok) {
    const detail = body && (body.message || body.error);
    const err = new Error(detail || "请求失败（HTTP " + res.status + "）");
    err.status = res.status;
    throw err;
  }
  return body;
}

async function fetchSpaces() {
  const spaces = await api("/api/v1/space");
  if (!Array.isArray(spaces)) throw new Error("空间列表响应格式异常");
  state.spaces = spaces;
  await persist({ spaces, spacesFetchedAt: Date.now() });
}

function describeError(err) {
  if (err.network) return err.message;
  if (err.status === 401) return "Token 无效、已过期或权限不足";
  return err.message;
}

/* ---------- 笔记内容 ---------- */

// markdown 链接：标题里的 [] 需转义，URL 里的括号/空格做百分号编码
function markdownLink(title, url) {
  const text = (title || url).replace(/\[/g, "\\[").replace(/\]/g, "\\]");
  const link = String(url)
    .replace(/%/g, "%25")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\s/g, "%20");
  return "[" + text + "](" + link + ")";
}

// 摘录笔记内容：选中内容 + 来源行（超长截断保护，后端上限 65535 字节）
function buildSelectionContent(capture) {
  if (!capture || !capture.text) throw new Error("未获取到选中内容，请重新选择后再试");
  let text = capture.text;
  if (text.length > MAX_TEXT_LENGTH) text = text.slice(0, MAX_TEXT_LENGTH) + "…";
  return text + "\n\n来源：" + markdownLink(capture.title, capture.url || "");
}

/* ---------- 空间图标渲染 ---------- */

const ICONIFY_API_HOST = "https://api.iconify.design";
const ICON_CACHE_KEY = "iconSvgCache";
const ICON_CACHE_MAX = 200;

// web 端自绘特殊图标（web/src/components/Icons.tsx 的 ProgressIcon / TimeProgressIcon），随 web 端同步维护
const SPECIAL_ICON_SVGS = {
  progress:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M4 5.5h8a2.5 2.5 0 0 1 0 5H4a2.5 2.5 0 0 1 0-5M0 8a4 4 0 0 1 4-4h8a4 4 0 0 1 0 8H4a4 4 0 0 1-4-4m4-1a1 1 0 0 0 0 2h5a1 1 0 0 0 0-2z" clip-rule="evenodd"/></svg>',
  time_progress:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true"><mask id="cflow-time-progress-mask" width="22" height="22" x="1" y="1" fill="#000" maskUnits="userSpaceOnUse"><path fill="#fff" d="M1 1h22v22H1z"/><path d="M12 2a10 10 0 1 1-7.071 2.929l2.828 2.828A6 6 0 1 0 12 6z"/></mask><g fill="none"><path fill="currentColor" d="M12 2a10 10 0 1 1-7.071 2.929l2.828 2.828A6 6 0 1 0 12 6z"/><path fill="currentColor" d="M12 2V1h-1v1zm6.344 2.27l.634-.773zm2.475 12.444l.882.471zm-4.992 4.525l.382.924zm-6.73.33l-.29.957zm-5.412-4.013l-.831.555zM2.048 11.02l-.995-.098zM4.93 4.929l.707-.707l-.707-.707l-.707.707zm2.828 2.828l.707.707l.708-.707l-.708-.707zM6.03 11.412l-.995-.098zm.982 3.921l-.831.556zm3.247 2.409l-.29.957zm4.038-.199l-.383-.924zm2.996-2.715l-.882-.471zm.593-3.998l-.981.194zm-2.079-3.468l.635-.773zM12 6h-1v1h1zm0-3a9 9 0 0 1 5.71 2.043l1.268-1.546A11 11 0 0 0 12 1zm5.71 2.043a9 9 0 0 1 3.117 5.201l1.962-.39a11 11 0 0 0-3.81-6.357zm3.117 5.201a9 9 0 0 1-.89 5.999l1.764.942a11 11 0 0 0 1.088-7.331zm-.89 5.999a9 9 0 0 1-4.493 4.072l.765 1.848a11 11 0 0 0 5.492-4.978zm-4.493 4.072a9 9 0 0 1-6.057.297l-.58 1.914a11 11 0 0 0 7.402-.363zm-6.057.297A9 9 0 0 1 4.517 17l-1.663 1.111a11 11 0 0 0 5.953 4.415zM4.517 17a9 9 0 0 1-1.474-5.882l-1.99-.196a11 11 0 0 0 1.8 7.19zm-1.474-5.882a9 9 0 0 1 2.593-5.482L4.222 4.222a11 11 0 0 0-3.169 6.7zm1.179-5.482L7.05 8.464L8.464 7.05L5.636 4.222zM7.05 7.05a7 7 0 0 0-2.016 4.264l1.99.196a5 5 0 0 1 1.44-3.046zm-2.016 4.264a7 7 0 0 0 1.146 4.575l1.663-1.111a5 5 0 0 1-.819-3.268zm1.146 4.575a7 7 0 0 0 3.788 2.81l.58-1.914a5 5 0 0 1-2.705-2.007zm3.788 2.81a7 7 0 0 0 4.71-.232l-.765-1.848a5 5 0 0 1-3.364.166zm4.71-.232a7 7 0 0 0 3.496-3.167l-1.764-.943a5 5 0 0 1-2.497 2.262zm3.496-3.167a7 7 0 0 0 .692-4.666l-1.962.39a5 5 0 0 1-.494 3.333zm.692-4.666A7 7 0 0 0 16.44 6.59l-1.269 1.546a5 5 0 0 1 1.732 2.89zM16.44 6.59A7 7 0 0 0 12 5v2a5 5 0 0 1 3.172 1.135zM13 6V2h-2v4z" mask="url(#cflow-time-progress-mask)"/><path stroke="currentColor" stroke-linecap="round" stroke-width="2" d="M12 12L5 5"/></g></svg>',
};

function pascalToKebab(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

/**
 * 解析图标名的拉取目标，返回 null 表示非图标名形态（emoji / 文字，按字面渲染）。
 * 语法与 web 端 parseIconName 对齐：特殊名 / lucide:kebab / 存量 PascalCase lucide / 其他 prefix:name（iconify）。
 * 插件不带 lucide 字典，lucide 名统一走 iconify 的 lucide 图标集在线拉取。
 */
function resolveIconRef(raw) {
  const v = (raw || "").trim();
  if (!v) return null;
  if (SPECIAL_ICON_SVGS[v]) return { special: v };
  if (v.includes(":")) {
    const parts = v.split(":");
    if (parts.length !== 2) return null;
    const [prefix, name] = parts;
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(prefix) || !/^[a-z0-9][a-z0-9-]*$/.test(name)) return null;
    return { prefix, name, cacheKey: prefix + ":" + name };
  }
  // 存量 lucide PascalCase 名（如 House）：转 kebab 后按 lucide:kebab 拉取
  if (/^[A-Z][A-Za-z0-9]*$/.test(v)) {
    const kebab = pascalToKebab(v);
    return { prefix: "lucide", name: kebab, cacheKey: "lucide:" + kebab };
  }
  return null;
}

const iconSvgMemCache = new Map(); // cacheKey -> Promise<svg 字符串 | null>，同一批渲染去重并发请求

async function readIconStore() {
  try {
    const data = await chrome.storage.local.get(ICON_CACHE_KEY);
    const store = data && data[ICON_CACHE_KEY];
    return store && typeof store === "object" ? store : {};
  } catch {
    return {}; // 存储不可用的注入环境不阻断渲染
  }
}

async function writeIconStore(store) {
  try {
    await chrome.storage.local.set({ [ICON_CACHE_KEY]: store });
  } catch {
    /* 写失败只损失缓存 */
  }
}

async function fetchIconSvg(prefix, name) {
  let res;
  try {
    res = await fetch(ICONIFY_API_HOST + "/" + encodeURIComponent(prefix) + ".json?icons=" + encodeURIComponent(name), {
      signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined,
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let data = null;
  try {
    data = await res.json();
  } catch {
    return null;
  }
  const icon = data && data.icons && data.icons[name];
  if (!icon || !icon.body) return null; // not_found 的图标不会出现在 icons 里
  const w = icon.width || data.width || 24;
  const h = icon.height || data.height || 24;
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + " " + h + '" fill="currentColor" aria-hidden="true">' + icon.body + "</svg>";
}

async function loadIconSvg(ref) {
  const store = await readIconStore();
  const hit = store[ref.cacheKey];
  if (hit && hit.svg) {
    hit.ts = Date.now();
    writeIconStore(store); // 刷新淘汰时间，写失败静默
    return hit.svg;
  }
  const svg = await fetchIconSvg(ref.prefix, ref.name);
  if (svg) {
    store[ref.cacheKey] = { svg, ts: Date.now() };
    const keys = Object.keys(store);
    if (keys.length > ICON_CACHE_MAX) {
      keys.sort((a, b) => store[a].ts - store[b].ts);
      for (const k of keys.slice(0, keys.length - ICON_CACHE_MAX)) delete store[k];
    }
    writeIconStore(store);
  }
  return svg;
}

function getIconSvg(ref) {
  if (!iconSvgMemCache.has(ref.cacheKey)) {
    const p = loadIconSvg(ref);
    // 拉取失败不常驻内存，下次渲染可重试
    p.then(
      (svg) => {
        if (!svg) iconSvgMemCache.delete(ref.cacheKey);
      },
      () => iconSvgMemCache.delete(ref.cacheKey)
    );
    iconSvgMemCache.set(ref.cacheKey, p);
  }
  return iconSvgMemCache.get(ref.cacheKey);
}

// 注入 SVG；overlay 所在页面可能启用 Trusted Types CSP 禁用 innerHTML，此时回退为字面文本
function setIconSvg(el, svg, fallbackText) {
  try {
    el.innerHTML = svg;
  } catch {
    el.classList.add("is-text");
    el.textContent = fallbackText;
  }
}

/**
 * 把空间图标值渲染进容器（.space-icon）：
 * emoji / 文字按字面同步渲染；图标名异步拉取 SVG，失败回退为字面文本，保证不空白也不报错。
 */
function applySpaceIcon(el, raw) {
  const v = (raw || "").trim();
  if (!v) return;
  const ref = resolveIconRef(v);
  if (!ref) {
    el.classList.add("is-text");
    el.textContent = v;
    return;
  }
  if (ref.special) {
    setIconSvg(el, SPECIAL_ICON_SVGS[ref.special], v);
    return;
  }
  getIconSvg(ref).then((svg) => {
    // 拉取失败回退为字面文本（旧版行为），网络恢复后刷新列表即可
    if (svg) setIconSvg(el, svg, v);
    else {
      el.classList.add("is-text");
      el.textContent = v;
    }
  });
}

/* ---------- 空间列表渲染 ---------- */

function spaceDisplayName(space) {
  return space.spaceId === "" ? DEFAULT_SPACE_NAME : space.spaceName || space.spaceId;
}

function spaceIcon(space) {
  if (space.spaceIcon) return space.spaceIcon;
  return space.spaceId === "" ? "🏠" : "📁";
}

function formatCount(n) {
  if (typeof n !== "number") return "";
  if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, "") + "w";
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

// 上次使用的空间排到最前，减少一次视线搜索
function orderedSpaces() {
  const list = [...state.spaces];
  const i = list.findIndex((s) => s.spaceId === state.lastSpaceId);
  if (i > 0) list.unshift(list.splice(i, 1)[0]);
  return list;
}

/**
 * 渲染空间列表到容器。
 * onPick(space, btn) 在用户点击某空间时回调，由调用方实现保存逻辑。
 */
function renderSpaceList(container, onPick, emptyText) {
  container.textContent = "";
  if (!state.spaces.length) {
    const empty = document.createElement("div");
    empty.className = "list-empty";
    empty.textContent = emptyText || "暂无空间，点右上角 ↻ 拉取";
    container.appendChild(empty);
    return;
  }
  for (const space of orderedSpaces()) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "space-item";
    btn.dataset.spaceId = space.spaceId;

    const icon = document.createElement("span");
    icon.className = "space-icon";
    applySpaceIcon(icon, spaceIcon(space));

    const name = document.createElement("span");
    name.className = "space-name";
    name.textContent = spaceDisplayName(space);

    btn.append(icon, name);

    if (space.spaceId === state.lastSpaceId) {
      const badge = document.createElement("span");
      badge.className = "space-badge";
      badge.textContent = "上次";
      btn.appendChild(badge);
    }

    const count = document.createElement("span");
    count.className = "space-count";
    count.textContent = formatCount(space.memoCount);
    btn.appendChild(count);

    btn.addEventListener("click", () => onPick(space, btn));
    container.appendChild(btn);
  }
}

// 保存成功后的按钮视觉，保存逻辑本身由调用方实现
function setSpaceListSaving(saving) {
  document.querySelectorAll(".space-item").forEach((b) => (b.disabled = saving));
}

function markSaved(btn) {
  btn.classList.add("saved");
  btn.querySelector(".space-name").textContent = "已保存 ✓";
}

/* ---------- Toast ---------- */

let toastTimer = null;

function toast(msg, isError) {
  const el = document.getElementById("cflow-toast");
  el.textContent = msg;
  el.classList.toggle("toast-error", !!isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}
