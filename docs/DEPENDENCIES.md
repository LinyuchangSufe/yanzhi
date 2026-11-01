# 首版依赖与许可证核查

核查日期：2026-10-28。范围为 `app/local/package.json`、`package-lock.json`、本机已安装包的许可文件及部分实际复制的资源。这里只做离线静态清单和风险识别，没有安装新包、执行依赖安装脚本、联网查询漏洞库，也不代表法律意见或全部分发许可已经完成清算。应用自身的 MIT 许可证不能替代第三方许可证。

## 可复现清单

从 `app/local` 执行：

```bash
node scripts/dependency-report.mjs
```

输出 [dependency-licenses.json](dependency-licenses.json)，记录包名、版本、runtime/dev 分类、可选依赖、锁定来源和 integrity、已安装状态、根许可文件路径与 SHA256、安装生命周期脚本，以及补充资源的许可文本路径与 SHA256。脚本不联网，不调用 npm，不执行被扫描包。报告绑定 package.json 与锁文件的 SHA256；更新依赖或在另一平台安装后需重新生成。

当前锁文件有 **258 个依赖条目**：220 个非 dev-only 条目、38 个 dev-only 条目，其中共 78 个可选条目；当前 macOS ARM64 环境安装了 193 个条目。条目数包含不同平台的二进制包，不等于当前进程实际加载的包数，也不等于独立项目数量。锁内所有条目均有 license 与 integrity 字段，下载来源均为 npm registry；这些事实不能证明无漏洞或供应链安全。

| 锁内许可表达式                           | 非 dev-only | dev-only |
| ---------------------------------------- | ----------: | -------: |
| MIT                                      |         180 |       35 |
| Apache-2.0                               |          17 |        1 |
| LGPL-3.0-or-later                        |          10 |        0 |
| Apache-2.0 AND LGPL-3.0-or-later         |           3 |        0 |
| Apache-2.0 AND LGPL-3.0-or-later AND MIT |           1 |        0 |
| ISC                                      |           5 |        0 |
| CC-BY-4.0                                |           1 |        0 |
| BSD-2-Clause                             |           1 |        0 |
| BSD-3-Clause                             |           1 |        0 |
| 0BSD                                     |           1 |        1 |
| MIT AND Zlib                             |           0 |        1 |

## 直接运行依赖

| 包                        | 锁定版本        | 包元数据声明 | 用途                                               |
| ------------------------- | --------------- | ------------ | -------------------------------------------------- |
| next                      | 16.4.3          | MIT          | 本地 Web 服务与构建；内部还有其他许可证，见下文    |
| react / react-dom         | 19.3.1 / 19.3.1 | MIT          | 界面与渲染                                         |
| pdfjs-dist                | 6.4.299         | Apache-2.0   | PDF 阅读、文本层、坐标转换；字体和辅助资源另有许可 |
| @codemirror/lang-markdown | 6.5.2           | MIT          | Markdown 编辑语言支持                              |
| @uiw/react-codemirror     | 4.25.12         | MIT          | CodeMirror React 编辑器                            |
| katex                     | 0.19.0          | MIT          | 数学公式显示                                       |
| lucide-react              | 1.59.0          | ISC          | 图标                                               |
| react-markdown            | 10.1.0          | MIT          | Markdown 预览                                      |
| rehype-katex              | 7.0.1           | MIT          | Markdown 数学渲染                                  |
| remark-gfm                | 4.0.1           | MIT          | GFM 支持                                           |
| remark-math               | 6.0.0           | MIT          | 数学语法                                           |
| remark-parse              | 11.0.0          | MIT          | 解析实际 Markdown 来源链接                         |
| unified                   | 11.0.5          | MIT          | Markdown 语法树流程                                |
| undici                    | 8.12.2          | MIT          | 受控 HTTP 请求                                     |
| zod                       | 4.6.7           | MIT          | API、快照及 AI 输出校验                            |

开发依赖为 `@types/node@26.6.5`、`@types/react@19.2.14`、`@types/react-dom@19.2.3`、`tsx@4.23.1`、`pdf-lib@1.17.1`（均声明 MIT），以及 `typescript@5.9.3`（Apache-2.0）。`pdf-lib` 只用于明确标注的测试 PDF；其开发依赖 `pako@1.0.11` 声明 MIT AND Zlib。

数据库使用 **Node 内置 `node:sqlite` 的 `DatabaseSync`**。精简版没有安装 `better-sqlite3`，也没有额外的 npm SQLite 原生编译依赖。Node 本体与其捆绑的 SQLite 等第三方组件，仍需按所选 Node 发行包的 LICENSE 核对；它们不在 npm 锁文件的 258 项中。

当前精简版锁内没有 `tldraw`、`openai`、`@anthropic-ai/sdk` 或 `@openai/codex-sdk`。没有 Canvas 商业许可依赖，也没有必需的云 AI SDK。可选远程模型通过 HTTP 调用；模型服务、已有账户授权和模型权重的许可与费用不因应用开源而免除。

## 包内资源与非 MIT 条目

**sharp / libvips。** Next 的可选依赖带入 `sharp@0.35.5`，其包声明 Apache-2.0；`@img/sharp-libvips-* @1.3.4` 平台包声明 LGPL-3.0-or-later，Windows/WASM 还存在 AND 组合许可。当前已安装的 `@img/sharp-libvips-darwin-arm64/README.md` 列出 libvips、glib、pango、librsvg、fribidi 等 LGPLv3 组件，cairo 为 MPL-1.1，此外还有 BSD、fontconfig、FreeType、libpng、IJG、zlib 等通知。本版源码未直接调用 sharp/next/image；它仍在锁和安装树中，不能按“没直接调用”忽略随包分发义务。制作二进制、容器或独立安装包时，应核对目标平台实际携带的组件、版权通知、适用源码与重新链接/替换义务，不能把它们重新标成 MIT。

**Next 内部 MPL。** `next` 的锁元数据只标 MIT，但已安装的 `next/dist/compiled/@vercel/og/LICENSE` 和 `.../satori/LICENSE` 实际包含 MPL-2.0 文本。本版没有使用 Open Graph 图像生成接口；分发 Next 的这些内置文件时仍需保留对应通知并核对适用要求。报告列出已检查路径，未将 Next 的所有内嵌组件都视为 MIT，也未声称已完成整个 Next 二进制/打包可达性审计。

**PDF.js 字体、CMap 与 WASM。** `scripts/assets.mjs` 将 worker、CMap、标准字体和 WASM 放在本地 `public/pdf`。它同时复制 PDF.js 根 Apache-2.0 LICENSE；目录中的 LICENSE 文件随资源保留。`standard_fonts/LICENSE_LIBERATION` 包含 GPL v2 及上游字体特定例外和其他条款，不应被 PDF.js 根 Apache-2.0 覆盖；`LICENSE_FOXIT`、CMap、OpenJPEG、QCMS、JBIG2 和 glue 代码也各有通知。具体约束以随包文本为准，不能把字体嵌入例外解读为整个应用自动取得单一许可证。包中 `iccs/LICENSE` 是 CC0-1.0；当前构建脚本没有复制该目录。

**caniuse-lite。** `caniuse-lite@1.0.30001819` 是 Next 的传递依赖，声明 CC-BY-4.0。发布包含这份浏览器兼容数据的制品时，应保留相应归属、许可和修改说明；应用 MIT 不会替代数据的署名要求。

上述补充文本不一定逐一出现在 npm 独立包清单中。报告只记录已核对的包内材料，不能用“锁内没有 MPL/GPL 项”推断打包产物没有这些许可证。

## 安全与运行边界

- 直接依赖已固定版本，传递依赖由 lockfile 与 integrity 锁定。升级后重新生成清单并运行类型、行为和构建检查；不要仅因上游提供更新就跳过验证。
- 锁内 `esbuild` 与可选 `fsevents` 有安装生命周期脚本。报告列出本机可见的实际命令；生成报告不会执行它们。安装依赖仍应使用可信锁文件并审阅相关脚本。
- Next SWC、sharp/libvips 与 PDF.js 的可选 Canvas 包包含平台二进制，npm license 字段无法完整描述其二进制组成或安全状况。其他平台的可选包未在本机加载验证。
- PDF、Markdown 与模型返回值均是不可信输入。当前实现采用 PDF.js 阅读、关闭 HTML 原样渲染、KaTeX `trust:false`、受控来源链接及 API 校验；这些措施不构成 PDF 解析器沙箱或完整安全审计。
- 本机服务默认仅回环访问，并有 Host/Origin 检查；可选 AI 与元数据解析涉及真实网络请求。AI 凭据仅由后端环境读取，不写入数据库配置或常规备份。
- `undici@8.12.2` 要求 Node >=22.19.0，因此应用和锁文件的最低版本声明已统一提升至 **Node >=22.19.0**。当前实际测试环境是 Node 25.9.0；最低版本尚未单独进行全流程回归。
- 可选 `pdftotext` 来自系统 Poppler，不在 npm 锁内；系统包与部署方式需单独核对。Ollama、浏览器、模型权重同样不属于此清单。

静态清单子任务没有联网查询 CVE。主执行者另于 2026-10-28 运行了 `npm audit --json`，在统一 KaTeX 版本后，锁定依赖报告 info/low/moderate/high/critical 均为 0（总计 258 条依赖）。这只表示当次 npm 公告库没有报告已知项，不能报告“零漏洞”或完整安全审计。发布或升级前仍应针对固定锁和目标平台重新检查；分发时一并保留适用的第三方许可文本与版权通知。
