# cflow_app

[cflow](https://cflow.cc) 笔记服务的客户端下载站：浏览器插件与安卓 APP。

两者都需要一个 cflow 服务端地址——用官方站 `https://cflow.cc`，或你自建的实例。

## 浏览器插件（Chrome / Edge 等 Chromium 内核）

浏览网页时随手把内容收进 cflow：

- **整页转发**：点插件图标，选个空间，当前网页即存为一条笔记
- **摘录转发**：框选一段文字 → 右键「发送到 cflow 笔记」→ 选空间保存（自动附来源链接）
- **快捷笔记**：插件内置编辑器，不必离开浏览器就能写一条，草稿自动保存

### 安装

1. 点本页面绿色 **Code** 按钮 → **Download ZIP**，解压到任意位置
2. 打开 `chrome://extensions`（Edge 为 `edge://extensions`），右上角开启 **开发者模式**
3. 点 **加载已解压的扩展程序**，选择解压出来的 **`cflow-browser-extension`** 目录（注意是里面的插件目录，不是最外层文件夹）

### 配置

1. 点浏览器工具栏的插件图标，首次会自动进入设置页
2. 填写服务地址（如 `https://cflow.cc`）和 API Token
3. 点 **测试连接并保存** 即可开始使用

API Token 在 cflow 网页端 **设置 → Access Token** 创建：用途选 **API**，权限默认「所有权限」，有效空间默认全部。

### 更新

重新 Download ZIP 解压后覆盖旧目录，回到 `chrome://extensions` 在插件卡片上点刷新（↻）。

## 安卓 APP

聚焦「轻量收集」：扫码配对、主页速记、系统分享、桌面小组件、通知推送。

### 下载安装

1. 下载 APK，任选其一：
   - **直达最新版**（始终指向最新 Release，点击直接下载）：[cflow.apk](https://github.com/Vespa314/cflow_app/releases/latest/download/cflow.apk)
   - 或打开 [Releases](https://github.com/Vespa314/cflow_app/releases) 页面，在具体版本的 Assets 里下载
2. 手机上打开下载的文件，按提示允许「安装未知应用」后完成安装
4. 打开 APP，网页端 **设置 → API Token → 扫码连接 APP** 生成二维码，扫码配对后即可使用

已安装的用户也可以在 APP 内 **设置 → 检查更新** 直接升级。
