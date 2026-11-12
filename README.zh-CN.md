# dsh-novels

[English](README.md) | **简体中文**

在 DeepSeek Harness 里阅读 `.txt` 小说：导入文件后自动分章，在对话旁边的面板里直接阅读。

<img width="900" alt="DeepSeek Harness 中的书架界面" src="docs/shelf.jpg">

状态：**Phase 2/3 已完成** —— 导入、书架、阅读器、进度恢复、改名、删除、阅读偏好（字号、行距、页宽）、上传进度、长书目录分组、空/错误/加载状态。

## 功能

- 点击按钮或拖拽导入 `.txt`；上限 20 MB，支持 UTF-8 / BOM / GB18030 / GBK / Big5 / UTF-16。
- 自动分章，无法识别章节标记时按 4000 字切块。
- 书架卡片显示章节数、字数、编码、阅读进度条和「读到第 N 章」；可就地改名；删除带确认。
- 阅读器：目录、上一章 / 下一章、字号、行距、页宽、键盘操作（← → PageUp PageDown 空格 j k Esc Ctrl±）、章节计数、底部进度条。
- 阅读位置（章节 + 滚动偏移）和阅读偏好持久化在 Host 端，刷新和重启都不会丢。`/api` 端口每次启动都会变，所以客户端不保存任何自身状态。
- 超过 300 章的长书会启用分组目录（每 100 章一块，只展开当前所在的块）。

## 截图

**阅读器** —— 目录、字号 / 行距 / 页宽控制、章节计数、键盘导航。

<img width="900" alt="阅读器面板" src="docs/reader.jpg">

**分组目录** —— 超过 300 章的书按每 100 章分块，只展开当前块。

<img width="900" alt="分组目录" src="docs/toc.jpg">

## 面板样式

样式表在插件激活时**一次性写入 `document.head`**（`ensureStyles()`，标签为 `style[data-plugin-css="dsh-novels/panel.css"]`）。

它原本是渲染在书架自身组件树里的 `<style>` 元素。所有规则都在同一个字符串里，书架看起来是对的——但打开一本书会卸载书架，样式元素也随之下线，阅读器就丢掉了整张样式表：没有 `height:100%`，没有 flex 列布局，没有 `overflow:auto`。表现出来就是阅读器滚不动、章节尾部被挤出面板。

把样式表放在 `head` 里，就不再依赖当前挂载的是哪个视图。`render.test.mjs` 断言了这个约定的两头（样式表在 `head` 中、面板树里没有 `<style>`）。

## 安装

```powershell
# 克隆一次，然后在要承载插件的 DSH profile 里安装
git clone https://github.com/darlingsakurua/dsh-novels.git
plugin_manager install_bundle target="<你的克隆路径>"
```

bundle 是以链接方式（而非复制）接入的，所以 `client/` 和 `lib/` 下的改动在插件重载后即生效（先 `plugin_manager set_plugin target="include:dsh-novels" enabled=false`，再设回 `true`）。

## 目录结构

```
dsh-novels/
  package.json         dsh.bundle.patch + dsh.client (platform: web)
  cordis.patch.yml     把 bundle 插入 profile
  icon.svg             侧边栏图标（currentColor）
  locale/{zh,en}.json  侧边栏提示用的面板标题
  lib/index.mjs        Host 端：/dsh-novels/api/v1 下的 HTTP 路由
  lib/store.mjs        Host 端：书库索引、原子写入、路径校验
  client/index.mjs     Web 端：书架 + 阅读器，以及文本处理管线
```

数据存放在 `<profileDir>/plugin-data/dsh-novels/`：

```
library.json              {version, prefs, books[]}
books/<id>.txt            归一化后的 UTF-8 正文
books/<id>.chapters.json  [{i, title, start}]
```

## API

所有路由的鉴权方式与内置的 `/api` 通道一致（请求必须携带 shell 已转发的浏览器会话）。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/ping` | 诊断信息（`dataDir`、`bookCount`、版本号） |
| GET | `/library` | 书籍列表 + 阅读偏好 |
| POST | `/books` | `{name, text, encoding, chapters}` → 创建书籍 |
| GET | `/books/{id}` | 书籍 + 章节偏移 |
| GET | `/books/{id}/text` | 以 `text/plain` 返回完整正文 |
| PATCH | `/books/{id}` | 改名（`{title, author}`） |
| PATCH | `/books/{id}/progress` | `{chapterIndex, offsetChars, percent}` |
| DELETE | `/books/{id}` | 删除书籍及其文件 |
| PATCH | `/prefs` | `{fontSize, lineHeight, measure, fontFamily}` |

响应信封统一为 `{ok: true, ...}` 或 `{ok: false, error, message}`；请求体上限：上传 24 MB，其余 64 KB。客户端在读取前就会拒绝超过 20 MB 的文件；Host 端的余量留给 JSON 信封（正文 + 章节偏移）。

## 文本处理流程

`client/index.mjs` 按以下顺序解码字节：BOM（UTF-8/UTF-16）→ 严格 UTF-8 → GB18030 → GBK → Big5。在计算章节偏移之前，换行符会统一归一化为 `\n`，因为每个偏移都是这段归一化文本中的字符索引。

章节标题用 `^第…[章节回卷篇部集]` 和 `^Chapter/Part/Book N` 匹配。如果某个标题到下个标题之间不足 200 字符，会被判定为误匹配并丢弃（并入上一章）；最后一章始终保留。完全没有标题的文件按 4000 字一块切分。

超过 300 章的目录按每 100 章分块渲染（`1–100`、`101–200`……），只展开包含当前章节的那一块。曾先尝试按标题首字分组，但放弃了：几乎所有中文章节标题都以「第」开头，结果只会分出一个桶。

## 测试

不需要测试框架 —— 普通 Node 脚本，各自打印 `ok`/`FAIL` 行：

```powershell
node _test/store.test.mjs        # Host store：索引、原子写入、边界钳制
node _test/client-parse.test.mjs # 解码/归一化/分章（针对打包后的客户端代码）
node _test/host-api.test.mjs     # 路由、信封、401/403 鉴权、请求上限
node _test/perf.test.mjs         # 5 MB GB18030 样本端到端
node _test/render.test.mjs       # 书架 → 上传 → 阅读 → 删除，无头 React
```

`render.test.mjs` 用一个迷你 React（hooks + 静态树）加载真实的客户端 bundle，并把 `fetch` 指向一套接在插件自身 Host 路由上的服务，从而在没有浏览器的情况下跑通浏览器流程。`_test/tmp/` 存放它用的一次性 profile。

`_test/make-sample.mjs` 可以重新生成 `samples/` 下的 GB18030 样本（那个 5 MB 的适合手动验证上传耗时）。

## 手动验收

以下项目无法在此环境中自动化（沙箱起不了浏览器）：

1. 导入 `samples/sample-gb18030-small.txt` 和 `samples/sample-gb18030-5mb.txt`。
2. 把 5 MB 那本读超过第 10 章，在章节中间滚动，再返回书架 —— 卡片应显示「读到第 N 章」且进度条有填充。
3. 重新打开：章节、滚动位置、字号/行距/页宽都应保持一致。
4. 在书架上给一本书改名；阅读器头部应跟随新标题。
5. 切换应用主题（浅色/深色）：所有面板表面与文字都应跟随 `--dsw-alias-*` 令牌。
6. 禁用插件（`set_plugin target="include:dsh-novels" enabled=false`）：书架图标消失，`/dsh-novels/api/v1/ping` 返回 404；重新启用并刷新，书还在。

## 本插件遵守的约定

- 绝不 require `@deepseek-ai/dsh-client-*`；只用 `react` 和内置模块。
- 绝不操作 `document.body`，也不使用 iframe；面板是插槽里的一个 React 树。（样式表是 `head` 里的 `<style>`，以命令式方式安装 —— 与 shell 自身的 style service 一致 —— 而不是面板内的 DOM。）
- 样式只使用 `--dsw-alias-*` 令牌 —— 不写死颜色。
- 键盘快捷键挂在阅读器容器上，绝不挂到 `window`。
- API 前缀是 `/dsh-novels/api/v1`；`/api` 属于 connection 通道。

## 许可

[MIT](LICENSE) © 2026 darlingsakurua
