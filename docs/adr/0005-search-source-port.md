# ADR-0005：SearchSource 端口——平台即召回引擎的可插拔边界

- 状态：已批准设计，实施中
- 日期：2026-09-17

## 背景

ADR-0004 把搜索定义为「模型规划 → 平台召回 → 本地重排 → 反馈再召回」的迭代循环，但实现把「平台」固定成了 CC98：`SearchSession` 知道 CC98 的分页语义、响应包壳、主题 URL、30 次/2 秒/20 条的请求策略；`content.tsx` 亲自读取 localStorage token 并构造 `Cc98Client`；`planner` 的提示词写死「论坛标题关键词」；`TopicCandidate` 混合了业务对象、CC98 召回簿记和排序中间态。

目标：新增一个网站 = 研究其登录方式、搜索 API、分页、字段映射和限流规则 → 写一个 adapter → 注册 → build。**验收标准：接入第二个搜索源时，`SearchSession` 主循环零修改、ranking/planner 核心零修改，新代码集中在 `sites/<id>/`。** 第二个 adapter 已定为朵朵校友圈。

## 决策

### 1. Adapter 与 Session 分离

- `SearchSourceAdapter`：无状态站点描述符，按 `id` 注册。声明 `capabilities`、`ratePolicy`、`pageMatches`、`apiHosts`（后两者供 manifest 消费）、`createSession(pageContext)`。
- `SearchSourceSession`：每次页面/认证绑定的实例。token、cookie、CSRF 等认证材料只存在于 session 与 adapter 内部，不进 UI、不进 core。
- UI 只做 `sourceRegistry.resolve(location.href)` → `adapter.createSession(...)` → `new SearchSession({ planner, source, budget })`。
- 错误面：`SourceError extends Error`，`code: 'not_logged_in' | 'rate_limited' | 'permission_denied' | 'network' | 'invalid_response'`。adapter 负责把本站 HTTP 状态与异常翻译为 `SourceError`；**`AbortError` 不翻译、原样传播**，core 用 AbortError 驱动取消。core 不再出现 `cc98_limited` 这类站点名。

### 2. SearchBudget 与 RatePolicy 是两个概念

- `SearchBudget`：用户为一次搜索给的时长预算，core 拥有。只扣减搜索侧耗时与强制等待，模型等待不消耗（沿用 ADR-0004）。
- `RatePolicy = { maxSearchCalls, minRequestIntervalMs }`：`maxSearchCalls` 是**逻辑 search() 调用次数上限**（adapter 内部分页展开不计入该口径——一次 `search()` 即一次调用）。
- **分页完全藏进 adapter**：`pageSize` 不进 core policy；`search()` 返回 `SearchPage { hits: SearchHit[], nextCursor?: string }`，cursor 是不透明字符串，offset/cursor/无分页的差异不出 adapter。

### 3. SearchHit、候选三层模型与 RankingDocument

- `SearchHit = { candidate: Candidate, document: RankingDocument, position?: number }`：adapter 一次同时供出业务对象与重排证据。`position` 是**当前检索词的完整结果流中的 1-based 位次**（第 1 页 1–20，第 2 页 21–40），由 adapter 自行计算——分页细节既归 adapter，core 不拿 pageSize 反推；无可信位次的搜索源返回 `undefined`。否则跨页排序会把「第 2 页第 1 条」误当高位次。RankingDocument 至此不再是图上的虚线——它随每次召回真实抵达 core。
- `Candidate`：`{ sourceId, id, title, url, author?, publishedAt?, section?, replyCount? }`。
- `RetrievedCandidate = { candidate, observations: RetrievalObservation[], documents: RankingDocument[] }`。core 不保存泛化「神秘分」；`RetrievalObservation = { round, query, position }` 忠实记录命中事实；`documents` 按 observation 次序累积——**同一 candidate 被多个检索词命中产生不同 snippet 时全部保留，不覆盖**。firstRound、跨检索命中、最佳位次全部由 observations 派生；ranking 自行决定如何使用多份 document（取并集/取首份等策略属 ranking 内部）。
- `RankingDocument = { title, section?, author?, publishedAt?, replyCount?, snippet? }`：封闭 schema，由 adapter 供出。`snippet` 允许非 title-only 站点提供命中片段用于本地重排——只进本地排序，不自动进模型反馈。
- `ScoredCandidate`：ranking 模块私有，排序键不再走私进公共类型。

### 4. 结构化 capabilities + core 构造的封闭白名单

- `SourceCapabilities = { searchSurface: 'title' | 'fulltext' | 'mixed', querySyntax: 'plain-keyword' | 'boolean' }`：**只枚举 CC98 与朵朵实测出来的能力**，不为未来网站提前枚举；实测出现新形态时先扩 union 再实现。`plannerNotes` 不设自由文本字段——提示词完全由结构化字段生成。
- `FeedbackEvidence`：core 拥有的封闭 schema `{ title, author?, publishedAt?, section?, replyCount? }` + 条数/字节上限（沿用 ADR-0004 白名单）。**完全由 core 从 `Candidate` 白名单字段构造，adapter 不再提供 `toFeedbackEvidence()`**——映射规则就是「取这几个字段」，没有 adapter 侧逻辑，隐私边界物理上不可能被 adapter 扩张。`snippet` 不属于 FeedbackEvidence，永不出域。

### 5. Registry ↔ manifest 契约测试

manifest 暂手写，但增加一个契约测试：断言 `∪(所有 adapter.pageMatches)` ⊆ manifest `content_scripts.matches`，且 `∪(所有 adapter.apiHosts)` ⊆ manifest `host_permissions`——是**并集被覆盖**而非单 adapter 与整份 manifest 相等（朵朵加入后单 adapter 不可能等于全集；manifest 未来还会含模型端点权限，覆盖关系比裸 equality 稳）。新增 adapter 忘记登记权限时测试先红，而不是运行时才发现请求被拦。

### 依赖方向

```
UI → sourceRegistry.resolve(location.href)
   → adapter.createSession(pageContext)
   → SearchSession（core：planner + ranking + SearchBudget + RatePolicy 执行）
        │
        └→ SearchSourceSession（port）
              ├─ Cc98Adapter（sites/cc98/：token、/topic/search、包壳解析、URL、错误翻译）
              └─ DuoAdapter（sites/duo/：第二个 adapter，证伪设计用）
```

## 影响

- core 不再 import 任何 CC98 常量、URL 或字段名；`MAX_CC98_REQUESTS`/`PAGE_SIZE`/`REQUEST_INTERVAL_MS` 从全局常量降级为 cc98 adapter 的 `ratePolicy` 与内部分页细节。
- 朵朵校友圈接入是端口的第一次证伪：若出现 `if (source === 'duo')` 散落 core，即判定 seam 失败并回炉。
- 不做 UniversalFactory 式框架；端口形状以「CC98 + 朵朵」两个样本为准，第三个站点来了再评审是否泛化。

## 未决

- ~~朵朵校友圈的认证方式、搜索 API、分页形态、字段与限流规则待调研~~ 已调研：`docs/research/duo-alumni-api-survey.md`。要点：微信扫码登录（token `ddtk` 存 `localStorage["auth-store"]`）、单 RPC 端点 `api.duoduo.link/api` + AES-GCM/RSA-OAEP 信封、offset 分页+`timestamp` 游标、无 title（`content` 即全文）、`capabilities={searchSurface:'fulltext', querySyntax:'plain-keyword'}`、搜索很可能要求登录态。`createSession` 形状与未决项（`ddtk`/`duo_session` 关系、`needCode` 阈值、`group_id` 语义）见该调研。
- `pageMatches`/`apiHosts` 聚合进 manifest 的构建期生成暂不实现，先靠契约测试保证一致。
