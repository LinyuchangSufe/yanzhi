# 来源与修改说明

研知由 [affromero/papernook](https://github.com/affromero/papernook) 的本地研究分支发展而来。基础版本为 v0.4.0，上游提交 `fa41f082c8f450e2536f2f8d6991e1d5899a9b02`。原作者 Andres Romero 的 MIT 版权和许可声明保留在本仓库 [LICENSE](../LICENSE) 中。

实际复用和适配的部分包括：

- 文献 URL、DOI/arXiv 标识归一化、PDF 地址发现及有界下载。
- PDF 参考文献、引用预览、目标页定位等纯逻辑。
- 数学公式分隔符处理、PDF.js 本地资源生成方式。
- 论文聊天上下文选择，以及适配到本版提供方接口的 CLI 调用流程。

本版使用独立的 SQLite 主数据模型，增加个人笔记、研究问题、想法讨论、来源引用、原稿历史、备份恢复与受控题录检索。未沿用上游的多用户身份、WebDAV 或 Canvas 系统；不能直接打开或替换上游的数据目录。

本项目的应用许可不覆盖用户导入的论文、模型权重或第三方资源。依赖说明见 [DEPENDENCIES.md](DEPENDENCIES.md)；PDF.js 的字体、CMap、WASM 等保留其包内声明，构建时由 `scripts/assets.mjs` 一同复制。仓库只分发原创合成测试 PDF，不附带第三方真实论文或维护者的知识库。
