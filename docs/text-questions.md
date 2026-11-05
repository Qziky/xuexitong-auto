# 简答与计算题的文本作答

简答、计算、论述、问答、解答题使用 `text` 类型，支持生成参考、展示、导出、填写、回读和服务端草稿核验。一个或多个正文编辑器均可处理，不改变识别、生成、填写、保存、提交之间的显式用户操作边界。

## 题型与答案位置

平台题型名称优先。缺少名称或仅标“其他题型”时，单个文本控件可作为正文位置；多个控件只有与题干填空标记对应时才回退为填空。明确命名的特殊题型及媒体、附件仍需人工处理。没有可靠作答位置的题目停止填写。

`AnswerProposal.blanks` 按网页实际位置排列。一个框对应一项答案，多个框按小问顺序逐项作答；题干有多个下划线而网页只有一个编辑器时，全部结果放在同一项。每项保持现有 2000 字符上限。模型缺少关键计算条件时须标记待检查；保留策略逐项保留已有答案。

## 编辑器与结果核验

新版 UEditor 的可见正文位于 iframe，旁边的隐藏 textarea 仅供同步。解析器根据已有编辑器标记、同题初始化声明或局部编辑器结构识别绑定，初始化声明只读取、不执行。填写沿用 `editorBridge` 的 `setContent`、`sync`，正文读取使用 `getContent` 返回的 HTML 经同一分行规则还原，不能仅写隐藏字段再从相同字段回读。无法确认的隐藏原生字段拒绝直写。

`EditorContent` 同时传回 HTML 和旧纯文本：`liveSnapshot` 对 text 题在惰性模板中解析 HTML，复用服务端快照的 `textAnswerContent` 保留换行、段落和空行；旧填空题仍使用原来的纯文本读值，保持既有校验方式。编辑器桥接不依赖后台 DOM，也不在注入函数中引用外部闭包。

服务端尚未初始化的编辑器从原始 HTML 读取正文并保留换行。批阅页的多框答案按平台明确的空位分组读取，不根据题干横线猜测拆分。文本识别核对题干标记与顺序，正文小问数不与编辑器数强行比较；原有填空题仍校验实际输入数量。

可填写子集回读一致只说明该子集成功。整份答案仍有空题、待检查题或缺少候选时，工作台保持填写步骤，提示未完成题数；允许保存当前草稿，禁止将部分成功报告为整份完成。没有任何可写候选时不会通过空集合比较得到成功。

## 文件与函数

| 文件 | 函数 | 作用 |
| --- | --- | --- |
| `domain.ts` | `isTextEntryType` | 统一判断填空和正文题是否使用文本位置流程。 |
| `page-parser.ts` | `answerInputs` | 获取真实作答控件，排除工具栏及编辑器内部辅助控件。 |
| 同上 | `isRichTextEditor` | 识别 UEditor 绑定，包括隐藏的同步字段。 |
| 同上 | `questionType` | 识别文本题，并在缺少可靠名称时保守回退。 |
| 同上 | `serverEditorText` | 读取服务端编辑器原始 HTML，正文保留换行。 |
| 同上 | `readQuestion` | 提取实际位置、已有答案、公布答案和结构问题。 |
| `answers.ts` | `needsSolve` | 按保留或覆盖策略判断是否需要模型答案。 |
| 同上 | `normalizeProposal` | 校验实际位置数量、内容及逐项保留策略。 |
| 同上 | `existingProposal` | 将网页原有答案转为统一候选结构。 |
| 同上 | `completeAnswer` | 判断所有位置是否有数量正确、非空且满足复核要求的答案。 |
| 同上 | `readbackMatches` | 比较候选与填写后读取的实际内容。 |
| `provider.ts` | `questionPayload` | 提供题干及按网页顺序排列的文本位置。 |
| `page-actions.ts` | `liveSnapshot` | 从桥接 HTML 还原正文分行，与服务端快照一致；旧填空沿用纯文本。 |
| 同上 | `fillPage` | 核验绑定后填写原生或富文本控件，拒绝未确认的隐藏字段直写。 |
| `background/task-writes.ts` | `writableAnswers` | 筛选结构可靠且有候选内容的题目。 |
| 同上 | `fillBound` | 保留旧答案、逐题填写，并区分子集回读与整份完整性。 |
| `background/workflows.ts` | `execute` | 对部分填写结束报告待检查。 |
| `background/editor.ts` | `editorBridge` | 在 MAIN 环境读写真实编辑器，并返回 HTML 和旧纯文本，由页面按题型还原。 |
| `draft-verification.ts` | `serverDraftMatches` | 比较服务端草稿中的文本位置、顺序和内容。 |
| `published-answer.ts` | `textAnswerContent` | 还原正文纯文本与换行，去除脚本和分数。 |
| 同上 | `parseAnswer` | 读取本人或平台公布答案，按明确空位分组处理多框正文。 |
| `question-export.ts` | `answerText` | 单框展示完整正文，多框按位置标号展示与导出。 |
| 同上 | `comparison` | 比较本人答案和参考答案。 |
| `recognition-settings.ts` | `blankMarkers` | 提取题干填空标记，供结构回退与识别校验复用。 |
| 同上 | `validateRecognitionMarkers` | 核对题干标记、编号和数学括号，正文不强行绑定输入框数量。 |
| `ui/Workspace.tsx` | `incompleteQuestions` | 根据真实回读答案统计未完成题目。 |
| 同上 | `workspaceStep` | 完整且回读通过才进入保存或提交阶段。 |
| 同上 | `Workspace` | 提示剩余题数并保留部分草稿入口。 |
| `tests/text-questions.test.ts` | `fixture`、`page` | 生成合成页面，并通过真实解析器构造检查输入。 |
| `tests/editor-sync-field.test.ts` | `question` | 构造单框和多框 UEditor 的合成结构。 |
| `tests/workspace-ui.test.ts` | `ready` | 构造尚未填写的合成页面，验证回读标记不能代替真实答案完整性。 |

处理版本升为 workflow 14 / page 19，使旧题型、编辑器分类或丢失分行的准备结果失效。扩展权限与发布版本号保持上游现状。

## 验证范围

合成回归覆盖题型识别、模型位置数量、逐项保留、单框和多框填写、实际 `editorBridge` 注入函数、可见正文与隐藏字段同步、回读、服务端草稿、批阅分组和部分完成状态。桥接样例模拟原 `getContentTxt` 会丢分行的行为，验证已有段落的保留、新答案换行与空行、HTML 转义及服务端一致性。真实浏览器只检查过编辑器结构，未进行安装后在线填写、模型吞吐或真实作业保存、提交验收。

贡献验证：`npm run release` 完成类型检查、80 个文件的 775 项测试、Edge 构建和打包；`npm audit --omit=dev` 为 0 个漏洞。

测试和文档不包含真实课程内容、答案、身份、签名地址或凭据；私人页面与诊断数据不进入贡献提交。升级后重新加载扩展并刷新课程页，再重新识别题目以使用新规则。
