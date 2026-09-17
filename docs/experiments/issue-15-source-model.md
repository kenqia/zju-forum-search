# Issue #15 实施记录

日期：2026-09-17。基线：`7992adf`。规格：[GitHub #15](https://github.com/kenqia/zju-forum-search/issues/15)、ADR-0005，以及本轮确认的“正文派生标题仅本地使用”约定。

## 改动与验证

- core 保留 Candidate、逐次 RetrievalObservation 和逐次 RankingDocument，不再提前计算泛化召回分。多份 document 的概念命中取并集，排除词在任一文档命中均计入排序；不跨文档拼接词语。
- ranking 的 ScoredCandidate 为私有类型。从 observations 计算不同查询数、最佳位次和首次轮次，未知位次排在已知位次之后。SearchSnapshot 仍返回结果卡片使用的 id/title/board/time/author/replyCount/url/firstRound，不再携带内部排序键。
- SearchBudget 单独计量请求与强制等待，模型等待不扣费。RatePolicy 继续来自 adapter，分页继续使用不透明 cursor。
- core 在 planner 端口前构造 FeedbackEvidence，并限制条数与 UTF-8 字节数。native 标题可反馈；body-derived 或缺失来源标记的标题反馈为空。模型 HTTP 层再按原白名单与总量限制序列化。
- CC98 adapter 声明标题为 native，搜索、分页和 UI 继续沿用既有行为。旧测试中反馈 ID 断言改为发布时间与条数断言，因为新端口明确不允许 ID 进入反馈；模型最终 JSON 的字段断言未放宽。

先写失败测试，分别复现多 document 丢失导致排序错误，以及正文派生标题越过 planner 边界，再实现修复。补充不同源策略、重复命中、未知位次、跨片段假短语、反馈负载限制用例。

最终命令：

```bash
cd frontend
npm run typecheck
npm test -- --pool=threads --maxWorkers=1
npm run build
```

结果：8 个测试文件、68 个测试通过；typecheck、构建及产物检查通过。真实浏览器和登录会话未测试。

## Standards

独立评审未发现实质缺陷或文档硬违规。一个非阻塞判断项：core 和 HTTP 层重复限制反馈长度；两层分别守住 planner 入参和最终序列化边界，本轮保留。

## Spec

独立评审未发现 #15 的实质阻塞问题。候选三层模型、私有排序键、源策略、独立预算和反馈白名单均符合本票。titleOrigin 是用户批准的隐私边界修订。#16 提示词和 #18 实际接入不属于本票完成范围。

Standards 有 1 个非阻塞判断项，Spec 无未解决发现。

## 朵朵资料补充

公开源码已补版本及公钥指纹、RSA-OAEP hash、AES-GCM IV/tag 编码、原始密文响应格式和分页行为；带源码指纹校验的离线互操作实验通过，详见 [调研记录](../research/duo-alumni-api-survey.md)。这些证据不替代登录后的验收。没有运行真实论坛搜索或上传任何论坛内容。
