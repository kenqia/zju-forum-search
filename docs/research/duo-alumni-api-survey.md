# 朵朵校友圈 API 调研

- 日期：2026-09-17
- 用途：决定 `SearchSourceAdapter` 第二个 adapter（`sites/duo/`）的 `createSession` 形状与 `capabilities` 实测值，见 [ADR-0005](../adr/0005-search-source-port.md)。
- 方法：访问站点前端 bundle、复现加密握手、未登录实测一次公开接口。未登录、未抓用户内容；凡需登录态才能确认的项目均标注「待用户会话内验证」。

## 站点本体

- 网址：`https://www.duoduo.link/`（`duoduo.link` 301 → `www`）；关于页 `https://about.duoduo.link/`，规则页 `https://about.duoduo.link/rules`。
- 定位：Z 世代高校互动社交平台，按院校分圈（`group_id`，浙大为主圈之一），自称「开源校园社区」。
- 前端形态：Vue 3 + Naive UI SPA（Vite 产物，alova 请求库，Pinia store persist 到 localStorage）；另有微信小程序端（部分功能标注「仅小程序可用」）。路由：`/`（timeline）、`/search`、`/a/:snsId`（帖子详情）、`/t/:topicId`（板块）、`/release`、`/experience`。

## 认证方式

- 登录：网页端弹窗「微信扫码授权登录」——前端调二维码接口取 `{code, qrCode}`，每 ~1.5s 轮询 `code` 换 `{ddtk}`，写入 user store 后 `refreshUserInfo()`。**未发现浙大统一认证/邮箱/密码入口**。
- token：`ddtk`，存于 `localStorage["auth-store"]`（JSON，字段 `token`，Pinia `persist.pick:["token"]`）。**非 cookie、非 HttpOnly**，扩展在页面上下文可直接读。请求时以自定义 header `ddtk: <token>` 附加（非 `Authorization: Bearer`）。有效期未查明（前端无过期处理，`isExpired:()=>!1`；失效靠服务端 authCode 触发 `$reset`）。
- 用户标识：登录后用户对象含 `duo_session`、`openid`、`group_id`、`nickname`、`vip_state` 等；`duo_session` 用于 Clarity identify 与 WebSocket 订阅。未登录调用户接口返回「缺少必要参数:duo_session」——推测 `ddtk` 即 `duo_session` 的值来源，服务端校验侧字段名为 `duo_session`，**待用户会话内验证**。

## API 传输协议（adapter 实现的关键差异点）

- 单一 RPC 端点：`POST https://api.duoduo.link/api`，body `{api: "<32位hex 方法id>", data: {...}}`；另有 `root:"ad"` 广告变体。
- **全链路加密**：前端用 AES-256-GCM 加密 `{api,data}` → `{params: <b64 密文+tag>, key: <RSA-OAEP 包裹的 "aesKey|iv">}`；RSA 公钥（2048 位 spki）硬编码于 bundle。响应同为 AES-GCM 密文，用同一 key/iv 解密。个别请求可带 `meta.noCrypto` 跳过。已用 Node crypto 复现握手成功（实测）。
- 响应包壳：明文 JSON `{status, msg, result}`；`status===0` 成功，`status===10000` 鉴权失效（前端据此登出）。HTTP 层错误另有 `{errorType:"Response Error"}` 包装。

## 搜索接口

- 方法 id：`d15476adc9b4d5f46125c3d8c420c556`（前端 `kp()`，`scene:"searchResult"`；同 api 服务 `search`/`searchIndex`/`playground` 等场景）。搜索建议另有 `61b5ddf1f483280e2ee1a1b2df469dc8`。
- 请求 `data`：`{keyword, page, limit(=20), timestamp, group_id, sort("hot_value"|"time"), topic_id, sub_topic_id, scene:"searchResult"}`。分页为 **offset 式 `page++` + `limit`，并回传 `timestamp` 作快照游标**；`isEnd` 由 `entry.length < limit` 推得。
- 响应 `result`：`{entry:[...], extra:{...}, tokens:[分词/高亮词], total, timestamp, needCode}`。`entry` 字段（前端使用到的）：`sns_id`、`content`（正文片段，配合 `tokens` 高亮）、`avatar`、`nickname`、`create_time`（及 `real_create_time`）、`comment_count`、`favor`、`reading`、`topic_id`、`topicName`、`cover`、`content_extra`、`isSuperiorGroupTimeline` 等。**无独立 title 字段**，`content` 即标题+正文片段。
- 详情 URL：`https://www.duoduo.link/a/{sns_id}`。
- **实测（未登录）**：完整加密握手 `POST /api` `{api:"d15476...c556", data:{keyword:"测试",page:1,limit:5,group_id:4,sort:"hot_value",scene:"searchResult"}}` → HTTP 200 `{status:0,msg:"成功",result:{entry:[],timestamp:1789643131,needCode:false,extra:{0..19:[]}}}`。未登录可调用、结构完整但 `entry` 为空——**搜索很可能要求登录态**（前端无 token 时亦 abort），`needCode` 疑似风控/验证码门槛。条目字段待用户会话内验证。
- 鉴权失败实测：用户接口（`9be551ff9ceaea708cc9ce2875de3acd`）→ HTTP 200 `{status:400, msg:"缺少必要参数:duo_session", result:null}`。

## 检索语义 / capabilities 草案

- 命中面：服务端分词 `tokens` + 前端对 `content` 高亮；无 title，`sort` 有 `hot_value`/`time`。判定 **`searchSurface: 'fulltext'`**（无独立标题，全文即标题），待登录实测确认。
- 查询语法：仅关键词 `keyword`；`topic_id`/`sub_topic_id`/`group_id`/`sort` 属结构化过滤而非语法 → **`querySyntax: 'plain-keyword'`**。

## 限流

- 未见显式 rate limit 文档或 429；`needCode` 字段暗示服务端风控门槛（高频可能置 true）。前端搜索无本地节流。建议 adapter 取保守 `ratePolicy`（`maxSearchCalls` 30、`minRequestIntervalMs` 500）；`status===10000` → `not_logged_in`，`needCode===true` → `rate_limited`。

## 与 ADR-0005 端口适配要点

- `pageMatches`: `https://www.duoduo.link/*`；`apiHosts`: `https://api.duoduo.link/*`。
- `createSession(pageContext)`：从 `localStorage["auth-store"]` JSON 读 `token`；无 token → `SourceError('not_logged_in')`。session 内用 WebCrypto 实现 AES-GCM+RSA-OAEP 信封（RSA 公钥常量随 adapter 分发），POST `{api: SEARCH_API_ID, data:{keyword,page,limit:20,timestamp,group_id,sort:"hot_value",scene:"searchResult"}}`，解密包壳。
- 分页 cursor：不透明 JSON `{page, timestamp}`，首次无 timestamp；`entry.length < limit` 时终止。
- `Candidate` 映射：`id=sns_id`、`url=/a/{sns_id}`、`title` 取 `content` 截断（无 title）、`author=nickname`、`publishedAt=create_time`、`section=topicName`、`replyCount=comment_count`；`RankingDocument.snippet=content`。
- `capabilities` 草案：`{searchSurface:'fulltext', querySyntax:'plain-keyword'}`。
- 与 CC98 最大差异：RPC 信封加密（非裸 REST）、header 名 `ddtk`、无 title、搜索很可能要求登录。

## 未决清单

- `ddtk` 与 `duo_session` 是否同值；token 有效期。
- 未登录 `entry` 为空是风控还是无结果——待用户本人会话内验证。
- `group_id` 语义（4 疑似浙大默认圈）与 `tokens`/`extra` 结构细节。
- `needCode` 触发条件与实际限流阈值。
- GitHub 是否有官方开源客户端/服务端（自称开源），未检索到可直接引用的仓库，待补查。
