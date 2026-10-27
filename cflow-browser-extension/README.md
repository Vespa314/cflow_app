# cflow 快存（Chrome 插件）

四种方式把内容存进 cflow：

1. **整页转发**：点击插件图标 → 选择空间 → 自动创建一条内容为裸网址的笔记
2. **摘录转发**：在网页里框选一段文字 → 右键「发送到 cflow 笔记」→ 页面正中央弹出
   悬浮选择层，笔记内容为「选中内容 + 来源行」：

   ```
   框选的内容

   来源：[网页标题](网址)
   ```

3. **快捷笔记**：点击插件图标 → 切到「记笔记」标签页 → 内置编辑器随手书写，
   选好空间发送；书写过程中草稿自动保存到本地（chrome.storage.local），
   发送成功才清空，下次打开面板可接着上次的继续写。支持 `Ctrl/⌘ + Enter` 快速发送。

4. **页内笔记**：在网页空白处右键「cflow笔记模式」，或在插件弹窗顶部点「记笔记模式」，
   页面内弹出可拖拽（顶栏）、可缩放（右下角）的浮动编辑器，置于页面所有元素之上；左下角选空间、右下角保存、
   右上角关闭。页面有视频正在播放时，底部出现「插入视频时间」按钮，点击把当前播放
   位置（`mm:ss`，超一小时为 `h:mm:ss`）插入到新一行的行首。草稿同样自动保存到本地。

登录：服务地址固定 `https://cflow.cc`，支持两种方式——

- **扫码登录**（推荐）：设置页点「扫码登录」，二维码直接显示在弹窗内，用手机
  cflow APP「扫一扫」确认。后端自动签发一条描述为「浏览器插件」的 Access Token
  （走 `pairing/web/*` 接口，与网页扫码登录同链路）；有效期跟随手机上所选档位，
  「长期」为 365 天。
- **粘贴 Token**：在网页「设置 → Access Token」创建 API Token 填入（见下文）。

空间图标渲染与网页端保持同一套语法：emoji / 文字图标 / 特殊名（progress、
time_progress）/ `lucide:kebab-name` 与存量 PascalCase lucide 名 / 其他
`prefix:name`（iconify，如 `mdi:home`）。矢量图标经 `api.iconify.design` 拉取
并缓存到本地，断网时回退为字面文本。

零构建，纯原生 Manifest V3 实现（二维码为 vendored 的 nayuki qrcodegen，MIT）。
图标由 `scripts/update_brand_icons.py` 从 `web/public/cflow_logo.png` 生成。

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `common.js` | 公共逻辑：固定服务地址、配置存储、API、扫码登录草稿键、空间图标渲染、空间列表渲染、笔记内容生成（popup/overlay 共用） |
| `popup.js` / `popup.html` / `app.css` | 工具栏弹窗：整页转发 + 快捷笔记 + 设置（内嵌扫码登录二维码） |
| `vendor/qrcodegen.js` | nayuki qrcodegen（MIT）移植：扫码登录出码用，已被 jsQR 端到端验证 |
| `background.js` | 右键菜单注册（摘录/笔记）、按需注入悬浮层、代理创建笔记与拉取空间（绕开页面 CORS） |
| `overlay/overlay.js` / `overlay.css` | 页面正中央的摘录选择悬浮层 |
| `overlay/note.js` | 页内浮动笔记编辑器（拖拽/缩放/视频时间插入） |

## 安装

1. 打开 `chrome://extensions`，右上角开启「开发者模式」
2. 点「加载已解压的扩展程序」，选择本目录（`cflow-browser-extension/`）

## 获取 API Token（手动登录用）

在 cflow 网页「设置 → Access Token」中创建：

- 用途（Purpose）选 **API**
- 权限（Privilege）默认 all 即可
- 有效空间默认全部（`*`）即可

## 配置插件

1. 点击浏览器工具栏的插件图标，首次会自动进入设置页
2. 点「扫码登录」用手机 APP 扫码；或粘贴 API Token 后点「测试连接并保存」
   ——会请求 cflow.cc 的访问权限，并拉取空间列表缓存到本地

## 日常使用

- 点插件图标弹出窗口，「转发网页」标签页顶部显示当前页面信息
- 点击任意空间即保存；上次使用的空间会排在最前并带「上次」标记
- 「记笔记」标签页里写完选空间发送，草稿自动保存，发送成功后自动关闭弹窗
- 两个编辑器输入 `#` 都会弹出当前空间的标签候选（↑↓ 换选、Enter/Tab 插入）
- 网页上看视频时用「cflow笔记模式」开浮动编辑器，随手插入时间点做笔记
- 空间有变动时点右上角 ↻ 刷新列表

## 改动代码后

回到 `chrome://extensions`，在插件卡片上点刷新图标（↻）即可生效。

## 依赖的后端接口

| 功能 | 接口 |
| --- | --- |
| 空间列表 | `GET /api/v1/space` |
| 创建笔记 | `POST /api/v1/memo` |
| 标签候选 | `GET /api/v1/tag?spaceId=`（与安卓端 listTags 同一接口） |
| 扫码登录发起/轮询 | `POST /api/v1/pairing/web/start`、`GET /api/v1/pairing/web/status`（`client=extension`，approved 时签发描述「浏览器插件」的 access token） |

> 注意：API token 访问 `/api/v1/space` 的权限由后端控制（`api/v1/jwt.go` 白名单 +
> `api/v1/space.go` 内的 token 权限校验）：列表只返回 token 被授权的空间，
> 创建/修改/删除空间对 API token 一律拒绝。旧版本服务需更新后插件才能拉取空间列表。
