// 整文件包 IIFE 并把公开符号挂到 globalThis：本文件会被 executeScript 重复注入到同一
// 页面（同页二次摘录），顶层 const/let 重声明会直接抛 SyntaxError 被 catch 吞掉，
// 导致二次摘录无响应。挂 globalThis 后重复注入只是覆盖引用，幂等安全。
(() => {
"use strict";

// popup 与页面悬浮层（overlay）共用的配置、API 与空间列表逻辑，统一在此维护。
// 注意：本文件也会注入到 service worker（background.js）与页面（overlay），
// 顶层不能出现 DOM 或 window 专属调用。

const DEFAULT_SPACE_NAME = "默认空间";
const DEFAULT_SERVER = "https://cflow.cc";
// 后端 api/v1/memo.go 的 maxContentLength 为 65535 **字节**（Go len() 按字节），
// 截断必须按 UTF-8 字节计：按字符数截 60000 时中文（每字 3 字节）约 2.2 万字即超限被拒
const MAX_TEXT_LENGTH = 60000;

// 按 UTF-8 字节数截断（超限补省略号，省略号也计入上限）
function truncateUtf8Bytes(text, maxBytes) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  const keep = maxBytes - 1;
  const cut = bytes.slice(0, keep);
  // 避免把一个多字节字符切成两半产生非法序列
  let end = cut.length;
  while (end > 0 && (cut[end - 1] & 0xc0) === 0x80) end -= 1;
  if (end > 0 && (cut[end - 1] & 0x80) !== 0) {
    const lead = cut[end - 1];
    const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (end + need > keep) end -= 1;
  }
  return new TextDecoder().decode(cut.slice(0, end)) + "…";
}

const state = {
  server: "",
  token: "",
  spaces: [],
  lastSpaceId: null,
};

/* ---------- 本地存储 ---------- */

// 服务地址固定为官方站，不再可配置；state.server 仅作 api() 的拼接常量
async function loadSettings() {
  const data = await chrome.storage.local.get(["token", "spaces", "lastSpaceId"]);
  state.server = DEFAULT_SERVER;
  state.token = data.token || "";
  state.spaces = Array.isArray(data.spaces) ? data.spaces : [];
  state.lastSpaceId = data.lastSpaceId ?? null;
}

function persist(patch) {
  return chrome.storage.local.set(patch);
}

// 本地草稿键（popup 面板 / 页内编辑器），换账号时须一并清除
const NOTE_DRAFT_KEY = "noteDraft";
const PAGE_DRAFT_KEY = "pageNoteDraft";

async function clearDrafts() {
  await persist({ [NOTE_DRAFT_KEY]: null, [PAGE_DRAFT_KEY]: null });
}

function isConfigured() {
  return !!state.token;
}

/* ---------- API ---------- */

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
  // 未登录（扫码登录流程）时不带 Authorization，空 Bearer 反而干扰部分网关
  const headers = { "Content-Type": "application/json" };
  if (state.token) headers.Authorization = "Bearer " + state.token;
  let res;
  try {
    res = await fetch(state.server + path, { ...options, headers });
  } catch {
    const err = new Error("无法连接服务器，请检查网络");
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
  await persist({ spaces });
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
  // 按字节判定：中文每字符 3 字节，按 UTF-16 长度判会漏放大 ~3 倍的量,
  // 未截断直接超后端 65535 字节上限被拒
  if (new TextEncoder().encode(text).length > MAX_TEXT_LENGTH) text = truncateUtf8Bytes(text, MAX_TEXT_LENGTH);
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
  return sanitizeIconSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + " " + h + '" fill="currentColor" aria-hidden="true">' + icon.body + "</svg>"
  );
}

// 净化 iconify 返回的 SVG：API 被劫持时 body 可携带事件属性/外链资源，
// 经 innerHTML 注入的目标含特权 popup（可读 token）。只保留基本图形元素与安全属性。
function sanitizeIconSvg(svg) {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const svgEl = doc.documentElement;
  if (!svgEl || svgEl.nodeName.toLowerCase() !== "svg") return null;
  const ALLOWED_TAGS = new Set([
    "svg", "path", "circle", "rect", "ellipse", "line", "polyline", "polygon",
    "g", "defs", "title", "mask", "clippath",
  ]);
  const ALLOWED_ATTR = new Set([
    "xmlns", "viewbox", "width", "height", "fill", "stroke", "stroke-width",
    "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "fill-rule",
    "clip-rule", "d", "cx", "cy", "r", "x", "y", "rx", "ry", "x1", "y1", "x2",
    "y2", "points", "transform", "fill-opacity", "stroke-opacity", "opacity",
    "mask", "clip-path", "aria-hidden",
  ]);
  const attrSafe = (attr) => {
    const name = attr.name.toLowerCase();
    if (name.startsWith("on")) return false;
    if ((name === "href" || name === "xlink:href") && attr.value.includes(":")) return false;
    return ALLOWED_ATTR.has(name);
  };
  const walk = (el) => {
    for (const child of Array.from(el.children)) {
      if (!ALLOWED_TAGS.has(child.nodeName.toLowerCase())) {
        child.remove();
        continue;
      }
      for (const attr of Array.from(child.attributes)) {
        if (!attrSafe(attr)) child.removeAttribute(attr.name);
      }
      walk(child);
    }
  };
  for (const attr of Array.from(svgEl.attributes)) {
    if (!attrSafe(attr)) svgEl.removeAttribute(attr.name);
  }
  walk(svgEl);
  return new XMLSerializer().serializeToString(svgEl);
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

/* ---------- # 标签联想（popup 与页内编辑器共用） ---------- */

// 每空间缓存一份标签：popup 生命周期短；background 随 service worker 回收自然过期
const tagCache = new Map();

async function fetchTags(spaceId) {
  const key = spaceId || "";
  if (tagCache.has(key)) return tagCache.get(key);
  const list = await api("/api/v1/tag?spaceId=" + encodeURIComponent(key));
  // 含空白的多词标签插入 #tag 会破坏解析，不进候选
  const tags = (Array.isArray(list) ? list : []).filter((t) => typeof t === "string" && t && !/\s/.test(t));
  tagCache.set(key, tags);
  return tags;
}

// textarea 没有光标坐标 API。用一份样式同步的离屏镜像量出第 position 个字符的位置，
// 返回值相对 textarea 边框盒左上角、尚未扣除滚动（与 textarea-caret 同一约定）。
function caretInTextarea(textarea, position) {
  const computed = window.getComputedStyle(textarea);
  const pos = Math.max(0, Math.min(position, textarea.value.length));
  const host = document.createElement("div");
  for (const [prop, value] of [
    ["position", "fixed"],
    ["left", "0"],
    ["top", "0"],
    ["opacity", "0"],
    ["pointer-events", "none"],
    ["overflow", "visible"],
    ["margin", "0"],
    ["padding", "0"],
  ]) {
    host.style.setProperty(prop, value, "important");
  }
  // 挂进 shadow，避免宿主页面的 div/span 样式把镜像排版打歪
  const shadow = host.attachShadow({ mode: "open" });
  const mirror = document.createElement("div");
  const style = mirror.style;
  style.whiteSpace = "pre-wrap";
  style.wordWrap = "break-word";
  style.overflowWrap = "break-word";
  style.position = "absolute";
  style.top = "0";
  style.left = "0";
  const copied = [
    "direction", "boxSizing", "width", "height", "overflowX", "overflowY",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "borderStyle",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "fontStyle", "fontVariant", "fontWeight", "fontStretch", "fontSize", "lineHeight", "fontFamily",
    "textAlign", "textTransform", "textIndent", "letterSpacing", "wordSpacing", "tabSize",
  ];
  for (const name of copied) style[name] = computed[name];
  // clientWidth 已去掉滚动条和左右边框，用它当镜像宽度，换行才和编辑框一致
  style.boxSizing = "border-box";
  style.width = Math.max(0, textarea.clientWidth) + "px";
  style.borderLeftWidth = "0";
  style.borderRightWidth = "0";
  style.height = "auto";
  style.overflow = "hidden";
  // 井号及之后的文字放进 span：offsetLeft/Top 取的是第一行起点，而不是整段的包围盒
  const marker = document.createElement("span");
  marker.textContent = textarea.value.slice(pos) || ".";
  mirror.append(document.createTextNode(textarea.value.slice(0, pos)), marker);
  shadow.appendChild(mirror);
  document.documentElement.appendChild(host);
  try {
    const borderLeft = parseFloat(computed.borderLeftWidth) || 0;
    const lineHeight = parseFloat(computed.lineHeight) || 18;
    const range = document.createRange();
    const node = marker.firstChild;
    range.setStart(node, 0);
    // 只框第一个字符：整段 span 的包围盒在换行后会向左扩到行首
    range.setEnd(node, Math.min(1, node.length));
    const mark = range.getClientRects()[0] || range.getBoundingClientRect();
    const base = mirror.getBoundingClientRect();
    return {
      // 镜像保留了上边框，top 差值已含边框；左右边框被置 0，left 要加回编辑框自己的
      top: mark.top - base.top,
      left: mark.left - base.left + borderLeft,
      height: mark.height || lineHeight,
    };
  } finally {
    host.remove();
  }
}

// 在 textarea 上挂 # 补全：输入 #词 弹出候选，↑↓ 换选、Enter/Tab 插入、Esc/失焦关闭。
// 候选贴着井号下方（放不下则翻到井号上方），对齐移动端 TagSuggestionPopup / 网页 TagSuggestions。
// 页内编辑器的浮层盖在 documentElement 上且 z-index 拉满，候选必须挂到同一层才能盖住编辑框。
// getTags 由调用方提供（popup 直连 / 页内经后台代理）；插入格式与 web 端 TagSuggestions
// 对齐：#tag + 尾随空格，词尾后已是空格则只补 #tag。返回 destroy 供编辑器卸载时清理。
function attachTagSuggest(textarea, getTags) {
  let drop = null;
  let items = [];
  let selected = 0;
  let caret = null;
  let trackRaf = 0;
  let placedKey = "";
  let seenWidth = -1;

  function currentToken() {
    const pos = textarea.selectionStart ?? textarea.value.length;
    const m = /#[^#\s\r\n]{0,64}$/.exec(textarea.value.slice(0, pos));
    return m ? { start: pos - m[0].length, end: pos, query: m[0].slice(1) } : null;
  }

  function css(el, decls) {
    for (const [prop, value] of Object.entries(decls)) el.style.setProperty(prop, value, "important");
  }

  // 锚在井号左下角。编辑框被拖动、页面滚动时矩形会变，调用方按需重算。
  function place() {
    if (!drop || !caret || !textarea.isConnected) return;
    const rect = textarea.getBoundingClientRect();
    const gap = 4;
    const margin = 8;
    let anchorX = rect.left + caret.left - textarea.scrollLeft;
    let lineTop = rect.top + caret.top - textarea.scrollTop;
    if (anchorX < rect.left) anchorX = rect.left + margin;
    if (anchorX > rect.right - margin) anchorX = rect.right - margin;
    if (lineTop < rect.top) lineTop = rect.top;
    if (lineTop > rect.bottom - caret.height) lineTop = Math.max(rect.top, rect.bottom - caret.height);
    const menuW = drop.offsetWidth || 160;
    const menuH = drop.offsetHeight || 40;
    let left = anchorX;
    let top = lineTop + caret.height + gap;
    if (left + menuW > window.innerWidth - margin) left = window.innerWidth - menuW - margin;
    left = Math.max(margin, left);
    if (top + menuH > window.innerHeight - margin) top = lineTop - menuH - gap;
    top = Math.max(margin, top);
    css(drop, { left: Math.round(left) + "px", top: Math.round(top) + "px", bottom: "auto" });
  }

  function track() {
    if (!drop) return;
    const rect = textarea.getBoundingClientRect();
    // 拖右下角改宽度会改变换行，井号的横坐标跟着变，需要重测
    if (rect.width !== seenWidth && rect.width > 0) {
      seenWidth = rect.width;
      const t = currentToken();
      if (t) {
        try {
          caret = caretInTextarea(textarea, t.start);
        } catch (err) {
          /* 沿用上一次量到的坐标 */
        }
      }
    }
    const key = [rect.left, rect.top, textarea.scrollTop, textarea.scrollLeft, caret && caret.left, caret && caret.top].join(":");
    if (key !== placedKey) {
      placedKey = key;
      place();
    }
    trackRaf = requestAnimationFrame(track);
  }

  function stopTrack() {
    cancelAnimationFrame(trackRaf);
    trackRaf = 0;
    placedKey = "";
    seenWidth = -1;
    textarea.removeEventListener("scroll", place);
  }

  function insert(tag) {
    const t = currentToken();
    if (!t) {
      hide();
      return;
    }
    const suffix = textarea.value[t.end] === " " ? "" : " ";
    textarea.setRangeText("#" + tag + suffix, t.start, t.end, "end");
    hide();
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.focus();
  }

  function hide() {
    stopTrack();
    caret = null;
    if (drop) {
      drop.remove();
      drop = null;
    }
    document.removeEventListener("pointerdown", onDocPointerDown, true);
  }

  function onDocPointerDown(e) {
    if (drop && e.target !== textarea && !drop.contains(e.target)) hide();
  }

  function render() {
    drop.textContent = "";
    items.forEach((tag, i) => {
      const row = document.createElement("div");
      row.textContent = "#" + tag;
      css(row, {
        display: "block",
        margin: "0",
        padding: "6px 10px",
        "border-radius": "6px",
        cursor: "pointer",
        "white-space": "nowrap",
        overflow: "hidden",
        "text-overflow": "ellipsis",
        background: i === selected ? "#eef0f6" : "transparent",
      });
      row.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        insert(tag);
      });
      drop.appendChild(row);
    });
    place();
  }

  async function refresh() {
    const t = currentToken();
    if (!t || !textarea.isConnected) {
      hide();
      return;
    }
    let list;
    try {
      list = await getTags();
    } catch {
      list = null;
    }
    // 等待期间光标可能已移动，按最新状态重算
    const latest = currentToken();
    if (!latest || !list) {
      hide();
      return;
    }
    const q = latest.query.toLowerCase();
    const starts = [];
    const contains = [];
    for (const tag of list) {
      const l = tag.toLowerCase();
      if (l.startsWith(q)) starts.push(tag);
      else if (l.includes(q)) contains.push(tag);
    }
    items = [...starts.sort((a, b) => a.localeCompare(b)), ...contains.sort((a, b) => a.localeCompare(b))].slice(0, 8);
    if (!items.length) {
      hide();
      return;
    }
    try {
      caret = caretInTextarea(textarea, latest.start);
    } catch (err) {
      hide();
      return;
    }
    selected = 0;
    if (!drop) {
      drop = document.createElement("div");
      css(drop, {
        position: "fixed",
        "z-index": "2147483647",
        "min-width": "120px",
        "max-width": "240px",
        "max-height": "240px",
        "overflow-x": "hidden",
        "overflow-y": "auto",
        margin: "0",
        padding: "4px",
        "border-radius": "10px",
        background: "#ffffff",
        border: "1px solid #e2e0dd",
        "box-shadow": "0 8px 28px rgba(0, 0, 0, 0.18)",
        "box-sizing": "border-box",
        "font-family": '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
        "font-size": "13px",
        "line-height": "1.45",
        color: "#1c1c1e",
      });
      // 页内笔记浮层盖住整个 body，候选挂到 documentElement 才能叠在编辑框上面
      const mount = textarea.closest(".cflow-note") ? document.documentElement : document.body;
      mount.appendChild(drop);
      document.addEventListener("pointerdown", onDocPointerDown, true);
      textarea.addEventListener("scroll", place);
    }
    render();
    if (!trackRaf) track();
  }

  function onKeyDown(e) {
    if (!drop) return;
    if (e.key === "Escape") {
      hide();
      e.stopPropagation(); // 页内编辑器的 Esc 是关窗，先只关候选
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      selected = (selected + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
      render();
      e.preventDefault();
      return;
    }
    if ((e.key === "Enter" || e.key === "Tab") && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (items[selected]) insert(items[selected]);
      e.preventDefault();
    }
  }

  textarea.addEventListener("input", refresh);
  textarea.addEventListener("keydown", onKeyDown);

  return function destroy() {
    hide();
    textarea.removeEventListener("input", refresh);
    textarea.removeEventListener("keydown", onKeyDown);
  };
}

/* ---------- 列表编辑（popup 记笔记与页内编辑器共用） ---------- */

const LIST_INDENT = "    ";
const TODO_LINE_RE = /^( *)- \[[xX ]\](.*)$/;
const UL_LINE_RE = /^( *)- (.*)$/;
const OL_LINE_RE = /^( *)(\d+)\. (.*)$/;

// 选区覆盖到的行。选区正好停在下一行行首时不含那一行（只框住了换行符）。
function listLineSpan(value, start, end) {
  const from = Math.min(start, end);
  let to = Math.max(start, end);
  if (to > from && value.charAt(to - 1) === "\n") to -= 1;
  const blockStart = value.lastIndexOf("\n", from - 1) + 1;
  const nl = value.indexOf("\n", to);
  const blockEnd = nl === -1 ? value.length : nl;
  return { blockStart, blockEnd };
}

function indentLineBlock(block, add) {
  const lines = block.split("\n");
  const deltas = [];
  const next = lines.map((line) => {
    if (add) {
      deltas.push(LIST_INDENT.length);
      return LIST_INDENT + line;
    }
    let n = 0;
    while (n < LIST_INDENT.length && line.charAt(n) === " ") n += 1;
    deltas.push(-n);
    return line.slice(n);
  });
  return { text: next.join("\n"), lines, deltas };
}

// 把块内的原始偏移映射到缩进之后。落在被删掉的前导空格里时收到行首。
function mapIndentIndex(pos, blockStart, blockEnd, lines, deltas) {
  if (pos < blockStart) return pos;
  if (pos > blockEnd) {
    let total = 0;
    for (const d of deltas) total += d;
    return pos + total;
  }
  let orig = blockStart;
  let shifted = blockStart;
  for (let i = 0; i < lines.length; i++) {
    const lineEnd = orig + lines[i].length;
    if (pos <= lineEnd) {
      const col = pos - orig;
      const nextCol = deltas[i] >= 0 ? col + deltas[i] : Math.max(0, col + deltas[i]);
      return shifted + nextCol;
    }
    if (i === lines.length - 1) break;
    orig = lineEnd + 1;
    shifted += lines[i].length + deltas[i] + 1;
  }
  let total = 0;
  for (const d of deltas) total += d;
  return pos + total;
}

function applyIndent(textarea, add) {
  const value = textarea.value;
  const start = textarea.selectionStart ?? 0;
  const end = textarea.selectionEnd ?? start;
  const { blockStart, blockEnd } = listLineSpan(value, start, end);
  const block = value.slice(blockStart, blockEnd);
  const { text, lines, deltas } = indentLineBlock(block, add);
  if (deltas.every((d) => d === 0)) return;
  const nextStart = mapIndentIndex(start, blockStart, blockEnd, lines, deltas);
  const nextEnd = mapIndentIndex(end, blockStart, blockEnd, lines, deltas);
  textarea.setRangeText(text, blockStart, blockEnd, "end");
  const a = Math.min(nextStart, nextEnd);
  const b = Math.max(nextStart, nextEnd);
  textarea.setSelectionRange(a, b);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

// 光标在行尾时，按当前行的列表标记续一行。待办优先于无序列表（"- [ ]" 也以 "- " 开头）。
function listContinuation(line) {
  const todo = TODO_LINE_RE.exec(line);
  if (todo) return todo[1] + "- [ ] ";
  const ul = UL_LINE_RE.exec(line);
  if (ul) return ul[1] + "- ";
  const ol = OL_LINE_RE.exec(line);
  if (ol) return ol[1] + (parseInt(ol[2], 10) + 1) + ". ";
  return null;
}

function applyListContinue(textarea) {
  if ((textarea.selectionStart ?? 0) !== (textarea.selectionEnd ?? 0)) return false;
  const pos = textarea.selectionStart ?? 0;
  const value = textarea.value;
  const lineStart = value.lastIndexOf("\n", pos - 1) + 1;
  const nl = value.indexOf("\n", pos);
  const lineEnd = nl === -1 ? value.length : nl;
  if (pos !== lineEnd) return false;
  const prefix = listContinuation(value.slice(lineStart, lineEnd));
  if (prefix == null) return false;
  textarea.setRangeText("\n" + prefix, pos, pos, "end");
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

// 在 attachTagSuggest 之后调用：候选列表打开时 Tab/Enter 已经 preventDefault，这里不再处理。
function attachListEditing(textarea) {
  function onKeyDown(e) {
    if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "Tab") {
      e.preventDefault();
      applyIndent(textarea, !e.shiftKey);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && applyListContinue(textarea)) {
      e.preventDefault();
    }
  }
  textarea.addEventListener("keydown", onKeyDown);
  return function destroy() {
    textarea.removeEventListener("keydown", onKeyDown);
  };
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


Object.assign(globalThis, {
  DEFAULT_SPACE_NAME,
  DEFAULT_SERVER,
  MAX_TEXT_LENGTH,
  NOTE_DRAFT_KEY,
  PAGE_DRAFT_KEY,
  clearDrafts,
  state,
  ICONIFY_API_HOST,
  ICON_CACHE_KEY,
  ICON_CACHE_MAX,
  SPECIAL_ICON_SVGS,
  iconSvgMemCache,
  toastTimer,
  truncateUtf8Bytes,
  loadSettings,
  persist,
  isConfigured,
  requestHostPermission,
  api,
  fetchSpaces,
  fetchTags,
  attachTagSuggest,
  attachListEditing,
  describeError,
  markdownLink,
  buildSelectionContent,
  pascalToKebab,
  resolveIconRef,
  readIconStore,
  writeIconStore,
  fetchIconSvg,
  loadIconSvg,
  getIconSvg,
  setIconSvg,
  applySpaceIcon,
  spaceDisplayName,
  spaceIcon,
  formatCount,
  orderedSpaces,
  renderSpaceList,
  setSpaceListSaving,
  markSaved,
  toast,
});
})();
