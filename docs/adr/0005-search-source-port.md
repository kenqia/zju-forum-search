# ADR-0005：SearchSource 端口——平台即召回引擎的可插拔边界

- 状态：已实施，交付复核通过；平台研究限制见结案记录
- 日期：2026-09-17

## 背景

ADR-0004 把搜索定义为「模型规划 → 平台召回 → 本地重排 → 反馈再召回」的迭代循环，但实现把「平台」固定成了 CC98：`SearchSession` 知道 CC98 的分页语义、响应包壳、主题 URL、30 次/2 秒/20 条的请求策略；`content.tsx` 亲自读取 localStorage token 并构造 `Cc98Client`；`planner` 的提示词写死「论坛标题关键词」；`TopicCandidate` 混合了业务对象、CC98 召回簿记和排序中间态。

目标：新增一个网站 = 研究其登录方式、搜索 API、分页、字段映射和限流规则 → 写一个 adapter → 注册 → build。**验收标准：接入第二个搜索源时，`SearchSession` 主循环零修改、ranking/planner 核心零修改，新代码集中在 `sites/<id>/`。** 第二个 adapter 已定为朵朵校友圈。

## 决策

### 1. Adapter 与 Session 分离

- `SearchSourceAdapter`：无状态站点描述符，按 `id` 注册。声明 `capabilities`、`ratePolicy`、`pageMatches`、`apiHosts`（后两者供 manifest 消费）、`createSession(pageContext)`。
- `SearchSourceSession`：每次页面/认证绑定的实例。token、cookie、CSRF 等认证材料只存在于 session 与 adapter 内部，不进 UI、不进 core。
- UI 只做 `sourceRegistry.resolve(location.href)` → `adapter.createSession(...)` → `new SearchSession({ planner, source })` 并以用户请求次数上限启动 `run(query, requestLimit)`。
- 错误面：`SourceError extends Error`，`code: 'not_logged_in' | 'rate_limited' | 'permission_denied' | 'network' | 'invalid_response'`。adapter 负责把本站 HTTP 状态与异常翻译为 `SourceError`；**`AbortError` 不翻译、原样传播**，core 用 AbortError 驱动取消。core 不再出现 `cc98_limited` 这类站点名。

### 2. 请求次数上限与 RatePolicy 是两个概念

- 用户请求次数上限：一次搜索允许发出的逻辑 `search()` 调用次数（默认 30，范围 1–100），core 拥有。分页请求同样计入该口径——一次 `search()` 即一次调用；模型调用不计数。
- `RatePolicy = { maxSearchCalls, minRequestIntervalMs }`：`maxSearchCalls` 是站点侧硬上限兜底，与用户上限取较小者；`minRequestIntervalMs` 是站点请求间的最小间隔。
- **分页完全藏进 adapter**：`pageSize` 不进 core policy；`search()` 返回 `SearchPage { hits: SearchHit[], nextCursor?: string }`，cursor 是不透明字符串，offset/cursor/无分页的差异不出 adapter。

### 3. SearchHit、候选三层模型与 RankingDocument

- `SearchHit = { candidate: Candidate, document: RankingDocument, position?: number }`：adapter 一次同时供出业务对象与重排证据。`position` 是**当前检索词的完整结果流中的 1-based 位次**（第 1 页 1–20，第 2 页 21–40），由 adapter 自行计算——分页细节既归 adapter，core 不拿 pageSize 反推；无可信位次的搜索源返回 `undefined`。否则跨页排序会把「第 2 页第 1 条」误当高位次。RankingDocument 至此不再是图上的虚线——它随每次召回真实抵达 core。
- `Candidate`：`{ sourceId, id, title, titleOrigin, url, author?, publishedAt?, section?, replyCount? }`。`titleOrigin` 为 `native` 或 `body-derived`；后者仅供本地展示，不作为标题发送给模型。
- `RetrievedCandidate = { candidate, observations: RetrievalObservation[], documents: RankingDocument[] }`。core 不保存泛化「神秘分」；`RetrievalObservation = { round, query, position }` 忠实记录命中事实；`documents` 按 observation 次序累积——**同一 candidate 被多个检索词命中产生不同 snippet 时全部保留，不覆盖**。firstRound、跨检索命中、最佳位次全部由 observations 派生；ranking 自行决定如何使用多份 document（取并集/取首份等策略属 ranking 内部）。
- `RankingDocument = { title, section?, author?, publishedAt?, replyCount?, snippet? }`：封闭 schema，由 adapter 供出。`snippet` 允许非 title-only 站点提供命中片段用于本地重排——只进本地排序，不自动进模型反馈。
- `ScoredCandidate`：ranking 模块私有，排序键不再走私进公共类型。

### 4. 结构化 capabilities + core 构造的封闭白名单

- `SourceCapabilities = { searchSurface: 'title' | 'fulltext' | 'mixed', querySyntax: 'plain-keyword' | 'boolean' }`：**只枚举 CC98 与朵朵实测出来的能力**，不为未来网站提前枚举；实测出现新形态时先扩 union 再实现。`plannerNotes` 不设自由文本字段——提示词完全由结构化字段生成。
- `FeedbackEvidence`：core 拥有的封闭 schema `{ title, author?, publishedAt?, section?, replyCount? }` + 条数/字节上限（沿用 ADR-0004 白名单）。**由 core 从 `Candidate` 白名单字段构造，adapter 不提供 `toFeedbackEvidence()`**。仅 `titleOrigin === native` 时复制标题；正文派生或缺少来源标记时，反馈标题为空字符串。其余字段仍按元数据白名单选择。`snippet`、ID、URL、observations 和本地排序键不跨越 planner 端口。标题来源是 adapter 必须遵守并测试的映射契约，字段白名单本身不证明来源可信。

### 5. Registry ↔ manifest 契约测试

manifest 暂手写，但增加一个契约测试：断言 `∪(所有 adapter.pageMatches)` ⊆ manifest `content_scripts.matches`，且 `∪(所有 adapter.apiHosts)` ⊆ manifest `host_permissions`——是**并集被覆盖**而非单 adapter 与整份 manifest 相等（朵朵加入后单 adapter 不可能等于全集；manifest 未来还会含模型端点权限，覆盖关系比裸 equality 稳）。新增 adapter 忘记登记权限时测试先红，而不是运行时才发现请求被拦。

### 依赖方向

```
UI → sourceRegistry.resolve(location.href)
   → adapter.createSession(pageContext)
   → SearchSession（core：planner + ranking + 请求次数上限 + RatePolicy 执行）
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

## 2026-09-17 接手审查补记

CC98 已迁至 `sites/cc98/`，UI 经 registry 创建 session。#15 已落地候选三层模型与 core 反馈白名单；#16 已落地能力提示词与反馈负载文件拆分，#17 已落地 registry 与 manifest 契约测试，#18 adapter 与 #19 向导已实现，真实会话验收待完成。#21 起用户控制由时长预算改为请求次数上限，`SearchBudget` 已移除，站点 `maxSearchCalls` 保留为硬上限兜底。详见 [接手审查](../research/search-source-handoff-review.md)。

用户已确认继续沿用正文不出域约定。朵朵 `content` 可作为本地展示标题和 RankingDocument.snippet，但必须标记 `titleOrigin: body-derived`，反馈中的 title 为空。没有原生标题时，模型仅能依据查询、检索命中数与其他允许的元数据决定后续搜索，不能从正文学习词汇。#16 的提示词应如实说明这一限制。

#15 的排序实现对每份 document 独立匹配，再取概念命中的并集，不把不同片段首尾拼成新词。时间使用第一份能解析日期的 document；展示元数据保留首次候选，首次轮次、不同查询数和最佳位次均由 observations 计算。排序键只存在 ranking 私有结构中，UI 结果保留现有展示字段。

朵朵公开前端版本与指纹、公钥来源、OAEP hash、AES key/IV/tag 编码及合成数据离线复现已补入调研记录。登录后字段和风控语义仍须用户本人会话验收，不凭未登录空结果推定已验证。

## #16 实施补记

首轮、盲扩展与反馈规划使用同一份 session capabilities，经 content 消息传入后台 `PlannerClient`。提示词按 searchSurface 与 querySyntax 生成，不依赖站点 ID。`feedback-payload.ts` 在 core 选择候选白名单字段，在模型请求序列化时再次限制字段和 4000 UTF-8 字节，包括当前日期。`text.ts` 承担文本归一化，adapter 和 ranking 不再为此依赖 planner。

## #18 / #19 实施补记

朵朵通过原有 SearchSourceSession 端口接入，SearchSession、ranking、planner 文件零修改。AES-GCM/RSA-OAEP 信封、认证、分页和字段映射均在 `sites/duo/`。显示标题标记为 body-derived，正文片段只参与本地排序。

接入暴露了应用入口的遗留耦合：background 只接受 CC98 sender URL，界面也固定显示 CC98。后台现改为复用 registry 校验来源，界面改用通用文案。这超出了 #18“diff 只在 adapter、registry、manifest”的字面范围，但没有改变搜索核心或增加按 source ID 分支。仅改 manifest 会导致朵朵页面无法调用模型，因此保留这两处必要入口修复及对应测试。

公开客户端在关闭圈层筛选时省略 group_id；用户圈层来自未持久化的用户资料。扩展不读取用户对象或增加用户资料请求，默认省略 group_id。adapter session 支持显式传入已知 groupId，但当前界面不提供圈层选择，也不默认使用 4。此行为不等同于原站的个人圈层搜索，真实范围列入向导待验证项。

`issue-18-19-acceptance-wizard.sh` 负责本人会话验收，不读取或保存凭据，未决项可保留为待验证。500ms 是 #18 指定的初始请求间隔，不是已验证的限流阈值。

回滚可 revert 本次实现提交，恢复原 registry、manifest 与页面入口；没有迁移浏览器存储或修改已有认证值。

## #12–19 交付复核

用户已运行朵朵手动向导并反馈整体使用良好，明确接受风控阈值不阻塞交付。公开源码与一次未登录请求补充核对了认证链路、圈层请求形态和加密协议。平台内部标识是否同值、空结果原因及风控阈值仍保留未知，不要求普通用户继续执行专业操作。此前“真实会话待完成”描述属于实施时状态，不等于本轮用户反馈仍缺失。详见 [结案记录](../experiments/issues-12-19-closeout.md)。
