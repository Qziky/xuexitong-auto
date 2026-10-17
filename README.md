# 超星课程任务助手

把学习通作业识别、参考与学习流程放进 Edge 侧栏。识别、填写、保存和提交都由你分别启动。

**A user-controlled Edge extension for Chaoxing coursework.** Review questions and candidate answers, then choose each action yourself.

[![Release](https://img.shields.io/github/v/release/Qziky/xuexitong-auto?display_name=tag&sort=semver)](https://github.com/Qziky/xuexitong-auto/releases)
[![License](https://img.shields.io/github/license/Qziky/xuexitong-auto)](LICENSE)
[![CI](https://github.com/Qziky/xuexitong-auto/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Qziky/xuexitong-auto/actions/workflows/ci.yml)
[![Stars](https://img.shields.io/github/stars/Qziky/xuexitong-auto?style=social)](https://github.com/Qziky/xuexitong-auto/stargazers)

![学习任务、公式和图片材料的浅蓝色插画](docs/images/readme-hero.png)

如果它对你的学习流程有帮助，欢迎点一颗 [Star](https://github.com/Qziky/xuexitong-auto) ⭐

## 主要功能

- **识别题目内容**：组合 OCR 与视觉识别，支持常见客观题、公式、图表和照片。公式可在侧栏中渲染；暂时无法可靠转成文字的题目会保留原图，后续生成参考时与已确认文字一起使用。
- **先看清，再决定**：题目、选项、我的答案、模型参考和平台公布答案分开展示。模型参考只是候选，不代表平台标准答案。
- **分步填写与提交**：生成参考不会自动填写。填写会回读核验，并默认保留已有答案；保存草稿和提交都需要单独操作，结果不明确时先核验，不重复提交。
- **前台学习任务点**：在当前浏览器标签页学习视频、音频、文档/PPT、图片和支持的章节题；可暂停、恢复或停止。遇到验证码、限流或登录失效时会暂停并等待你处理。
- **导出与检查**：按需导出题目文本和答案；不支持可靠作答的简答、附件等题型会列出供人工检查。

## 安装

需要 Edge 或其他 Chromium 116 及以上版本。

1. 前往 [GitHub Releases](https://github.com/Qziky/xuexitong-auto/releases/latest)，下载最新的 `*-edge.zip` 并解压到一个固定目录。
2. 打开 `edge://extensions`，开启「开发人员模式」，选择「加载解压缩的扩展」，并选中包含 `manifest.json` 的目录。
3. 打开扩展侧栏，在「设置」中填写你自己的 OpenAI 兼容模型服务地址、模型和 API Key。安装包不预置密钥。

升级时将新版文件放回原扩展目录，在扩展页点击「重新加载」，再刷新学习通页面。保留原安装身份可继续使用本机设置和历史记录。

## 第一次使用

1. 登录学习通并打开一项作业，在扩展侧栏选择「识别文字」。
2. 检查题干、选项及识别记录；需要时确认文字或重新识别。
3. 选择「生成参考答案」获取候选答案，并自行核对。
4. 确认后再单独选择「填写答案」「保存草稿」或「提交」。

打开题目页不会自动调用模型。扩展不会因为生成候选答案而填写、保存或提交。

## 隐私与使用边界

- 定时列表刷新只读取课程概览和普通作业列表，不读取题目内容、章节卡片，也不调用模型。只有你启动识别、生成参考或学习操作后，扩展才读取对应内容。
- 题目文字、选项及视觉流程需要的图片会发送到你配置的模型服务；请求不携带浏览器 Cookie。模型服务的数据处理方式由服务提供方的政策决定。
- 课程、任务和历史保存在本机扩展存储中；题目原图材料保存在本机 IndexedDB，并按容量与有效期清理。密钥只在可信扩展上下文中使用，不写入日志或导出。
- 遇到验证码、平台限流或登录失效时，扩展会暂停，不自动识别或绕过验证。自动化操作不保证被平台接受。

详细说明见 [隐私说明](PRIVACY.md)、[安全报告说明](SECURITY.md) 和 [使用边界](docs/acceptance.md)。

## 文档

- [0.6.0 升级说明](docs/upgrade-0.6.0.md)
- [验收说明](docs/acceptance.md)
- [自动调试说明](docs/debugging.md)
- [贡献指南](CONTRIBUTING.md)
- [第三方许可](THIRD_PARTY_NOTICES.md)

## 开发与验证

```powershell
npm.cmd ci
npm.cmd run typecheck
npm.cmd run test
npm.cmd run preview
npm.cmd run release
```

预览和测试使用合成数据，不操作真实平台。发布命令会生成可加载扩展、扩展 ZIP、源码 ZIP 和 SHA256 校验和。

## 许可证与声明

本项目使用 [MIT 许可证](LICENSE)，是独立的第三方扩展，与超星或学习通无隶属关系。请仅对你有权访问的课程和内容使用，并在操作前核对题目、答案及课程规则。
