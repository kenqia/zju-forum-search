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
- **应用层加密信封**：前端用 AES-256-GCM 加密 `{api,data}` → `{params: <b64 密文+tag>, key: <RSA-OAEP 包裹的 "aesKey|iv">}`；RSA 公钥硬编码于 bundle。2026-09-17 复核为 4096 位 SPKI，早先记录的 2048 位不准确。响应同为 AES-GCM 密文，用同一 key/iv 解密。个别请求可带 `meta.noCrypto` 跳过。前次记录称已完成未登录握手，但未保留可复核脚本；本轮只验证公开源码和离线加密互操作，不重申服务端握手已验收。
- 响应包壳：明文 JSON `{status, msg, result}`；`status===0` 成功，`status===10000` 鉴权失效（前端据此登出）。HTTP 层错误另有 `{errorType:"Response Error"}` 包装。

## 搜索接口

- 方法 id：`d15476adc9b4d5f46125c3d8c420c556`（前端 `kp()`，`scene:"searchResult"`；同 api 服务 `search`/`searchIndex`/`playground` 等场景）。搜索建议另有 `61b5ddf1f483280e2ee1a1b2df469dc8`。
- 请求 `data`：`{keyword, page, limit(=20), timestamp, group_id, sort("hot_value"|"time"), topic_id, sub_topic_id, scene:"searchResult"}`。分页为 **offset 式 `page++` + `limit`，保留首个 `timestamp` 作后续页的快照游标**；`isEnd` 由 `entry.length < limit` 推得。
- 响应 `result`：`{entry:[...], extra:{...}, tokens:[分词/高亮词], total, timestamp, needCode}`。`entry` 字段（前端使用到的）：`sns_id`、`content`（正文片段，配合 `tokens` 高亮）、`avatar`、`nickname`、`create_time`（及 `real_create_time`）、`comment_count`、`favor`、`reading`、`topic_id`、`topicName`、`cover`、`content_extra`、`isSuperiorGroupTimeline` 等。**无独立 title 字段**，`content` 即标题+正文片段。
- 详情 URL：`https://www.duoduo.link/a/{sns_id}`。
- **前次调研记录（未登录，本轮未重跑）**：完整加密握手 `POST /api` `{api:"d15476...c556", data:{keyword:"测试",page:1,limit:5,group_id:4,sort:"hot_value",scene:"searchResult"}}` → HTTP 200 `{status:0,msg:"成功",result:{entry:[],timestamp:1789643131,needCode:false,extra:{0..19:[]}}}`。未登录可调用、结构完整但 `entry` 为空——**搜索很可能要求登录态**（当前公开脚本的搜索 middleware 只显示空关键词会 abort，不能据此认定缺少 token 必然被拒绝），`needCode` 疑似风控/验证码门槛。条目字段待用户会话内验证。
- 前次鉴权失败记录，本轮未重跑：用户接口（`9be551ff9ceaea708cc9ce2875de3acd`）→ HTTP 200 `{status:400, msg:"缺少必要参数:duo_session", result:null}`。

## 检索语义 / capabilities 草案

- 命中面：服务端分词 `tokens` + 前端对 `content` 高亮；无 title，`sort` 有 `hot_value`/`time`。判定 **`searchSurface: 'fulltext'`**（无独立标题，全文即标题），待登录实测确认。
- 查询语法：仅关键词 `keyword`；`topic_id`/`sub_topic_id`/`group_id`/`sort` 属结构化过滤而非语法 → **`querySyntax: 'plain-keyword'`**。

## 限流

- 未见显式 rate limit 文档或 429；`needCode` 字段暗示服务端风控门槛（高频可能置 true）。前端搜索无本地节流。前次建议 `ratePolicy` 为 `maxSearchCalls:30, minRequestIntervalMs:500`；500ms 尚无阈值证据，不能称为已验证的保守值；`status===10000` → `not_logged_in`，`needCode===true` → `rate_limited`。

## 与 ADR-0005 端口适配要点

- `pageMatches`: `https://www.duoduo.link/*`；`apiHosts`: `https://api.duoduo.link/*`。
- `createSession(pageContext)`：从 `localStorage["auth-store"]` JSON 读 `token`；无 token → `SourceError('not_logged_in')`。session 内用 WebCrypto 实现 AES-GCM+RSA-OAEP 信封（RSA 公钥常量随 adapter 分发），POST `{api: SEARCH_API_ID, data:{keyword,page,limit:20,timestamp,group_id,sort:"hot_value",scene:"searchResult"}}`，解密包壳。
- 分页 cursor：不透明 JSON `{page, timestamp}`，首次无 timestamp；`entry.length < limit` 时终止。
- `Candidate` 映射：`id=sns_id`、`url=/a/{sns_id}`、`title` 取 `content` 截断作本地展示，必须标记 `titleOrigin: body-derived`，反馈标题为空（无原生 title）、`author=nickname`、`publishedAt=create_time`、`section=topicName`、`replyCount=comment_count`；`RankingDocument.snippet=content`。
- `capabilities` 草案：`{searchSurface:'fulltext', querySyntax:'plain-keyword'}`。
- 与 CC98 最大差异：RPC 信封加密（非裸 REST）、header 名 `ddtk`、无 title、搜索很可能要求登录。

## 未决清单

- `ddtk` 与 `duo_session` 是否同值；token 有效期。
- 未登录 `entry` 为空是风控还是无结果——待用户本人会话内验证。
- `group_id` 语义（4 疑似浙大默认圈）与 `tokens`/`extra` 结构细节。
- `needCode` 触发条件与实际限流阈值。
- GitHub 是否有官方开源客户端/服务端（自称开源），未检索到可直接引用的仓库，待补查。


## 2026-09-17 公开源码复核

本轮只 GET 公开首页及其静态脚本，没有访问本人浏览器、读取登录态或向搜索 RPC 发请求。资料来源：

- [站点首页](https://www.duoduo.link/)，响应 SHA-256 `3ce2efffe53260c9582d4cae691a3397578bd53c6837d98af5f7447ff07553ff`。
- [index-DtY5Q9_f.js](https://www.duoduo.link/assets/index-DtY5Q9_f.js)，解压后 1,594,770 字节，SHA-256 `6d26f218a242a071206e9a4efb39c1ed5939f55e5405d549c37e873aef6bde7e`。这是本次证据的版本标识，站点升级后应重新复核。
- 公钥位于该脚本的 `zR` 模板字符串，标准 base64 编码的 SPKI DER，550 字节；SHA-256 `f3f43959d3de920289d4ccc1b45db747a4478daf49e9ce5490ea7f542422af33`。Node `createPublicKey` 解析为 RSA 4096 位、指数 65537。它是公开加密公钥，不是用户认证材料。

| 源码锚点 | 核实的行为 |
| --- | --- |
| `HR` / `UR` | WebCrypto 生成 AES-256-GCM key；每次请求生成 16 字节随机 IV；UTF-8 JSON 被加密为 ciphertext + 默认 128 位 tag，整体标准 base64 编码。 |
| `VR` / `GR` | 以 SPKI 导入 RSA 公钥，OAEP hash 为 SHA-256；输入为 UTF-8 的 `base64(aesKey) + "|" + base64(iv)`，RSA 密文再作 base64。 |
| `KR` / `Nw.beforeRequest` | HTTP body 只有 `{params,key}`；`aesKey`、`aesIv` 留在本地请求 metadata。 |
| `Nw.onSuccess` / `XR` / `WR` | 读取 `response.text()`，视作 base64 AES-GCM 密文；用该请求的同一 key 和 IV 解密，再 JSON.parse。不是先解析一个 JSON 密文包壳。 |
| `uu` / `FM` | 解密后以 `status` 判断，0 成功，10000 触发认证失效处理；数据字段为 `result`，消息字段为 `msg`。 |
| `assignToken` / `auth-store` | store 只持久化 `token`，请求附加 `ddtk` header。此结论来自公开代码，不涉及读取任何实际值。 |
| `kp` / `scene:"searchResult"` | 搜索 RPC id 与前次记录一致。`group_id` 根据页面筛选及用户圈层选择，不能全局硬编码为 4。 |
| `Np` | 每页 `page += 1`；仅在首次 timestamp 为空时保存返回 timestamp，后续页沿用它。`entry.length < limit` 为末页，默认 limit 20。 |

当前完整脚本未检出 `needCode` 字样。前次空响应记录不能证明它的触发阈值，也不能证明当前网页如何处理。#18 必须将该项标为待真实响应验证，不能用合成 fixture 宣称服务端语义已确认。

## 离线复现

仓库脚本 [verify-duo-envelope.mjs](../../frontend/scripts/verify-duo-envelope.mjs) 使用 Node 内置 WebCrypto 与 OpenSSL API，生成临时合成 key 和消息，无网络调用、不读取真实凭据。它验证 WebCrypto 请求能被 Node 解包，Node 合成响应能被 WebCrypto 解包，以及篡改 tag 会被拒绝。可选的 bundle 参数校验上述公开版本和公钥指纹，不执行下载的脚本。

```bash
curl --compressed --fail --max-time 60 -sS \
  https://www.duoduo.link/assets/index-DtY5Q9_f.js \
  -o /tmp/duo-index-DtY5Q9_f.js
node frontend/scripts/verify-duo-envelope.mjs /tmp/duo-index-DtY5Q9_f.js
# 无需下载即可运行合成协议实验：
node frontend/scripts/verify-duo-envelope.mjs
```

本轮带 bundle 指纹的实验通过。它证明已记录的格式可离线互操作，不证明服务端接受请求，也不证明登录后的搜索字段、全文召回能力、圈层或风控阈值。上述真实会话项目仍在 #18/#19 验收范围内。
