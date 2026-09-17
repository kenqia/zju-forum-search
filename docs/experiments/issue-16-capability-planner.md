# #16 能力提示词与反馈边界验证

日期：2026-09-18。

## 实现

搜索 session 的 `SourceCapabilities` 通过 content 消息传入后台 planner。首轮、盲扩展和反馈轮使用相同能力。CC98 的 `title + plain-keyword` 生成标题匹配提示词；朵朵预定的 `fulltext + plain-keyword` 生成全文匹配提示词，不要求关键词出现在标题中。朵朵 adapter 尚未接入，这次验证使用合成能力与数据。

反馈白名单与负载上限集中在 `feedback-payload.ts`。core 只复制原生标题及允许的元数据；正文派生标题置空。模型请求序列化再次执行白名单与字节限制，包含当前日期。正文、片段、ID、URL 和召回记录不进入模型负载。

## 验证

在 `frontend/` 执行：

- `npm run typecheck`：通过。
- `npm test -- --maxWorkers=2`：8 个文件、77 项测试通过。
- `npm run build`：类型检查、content/background 构建及 `verify:dist` 均通过。
- 仓库根目录 `git diff --check`：通过。

能力测试覆盖三种 searchSurface 和两种 querySyntax，以及三种规划调用。消息测试检查能力传递，并拒绝缺失或非法能力。原有搜索会话测试继续覆盖正文派生标题不出域和 planner 端口的 4000 UTF-8 字节上限；最终负载测试把当前日期计入预算。

首次默认并行的全量测试因 8 个 worker 启动超时而没有执行用例。降低到 2 个并行 worker 后通过，未修改项目测试配置。

本次没有调用真实模型服务或登录站点，尚未验证真实模型输出质量和朵朵登录后的搜索行为。
