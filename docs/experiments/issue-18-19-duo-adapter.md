# #18 / #19 朵朵 adapter 与验收向导

日期：2026-09-18。基线：`3d5d3713ea8a1698348ec56bbfd6cb056363cc3c`。

## 实现范围

朵朵 adapter 负责读取原站 auth-store 的 token、发送 ddtk header、AES-256-GCM/RSA-OAEP 信封、快照分页、SearchHit 映射及错误翻译。公钥来自已记录的公开 bundle，SPKI 指纹已复核。每次请求生成独立 key/IV；响应按原站协议用该请求的 key/IV 解密。请求不允许重定向，避免认证 header 被转发到其他地址。

完整结果流位次使用原始 entry 下标计算，坏条目不会让后续位次前移，也不会把满页误判为末页。后续页保留首个 timestamp。正文截断为本地显示标题，标记 body-derived；完整片段参与本地排序，模型反馈标题为空。

SearchSession、ranking.ts、planner.ts 相对基线零修改。registry 和 manifest 新增朵朵。后台原来只接受 CC98 sender，现复用 registry 校验；界面改为通用搜索文案。这两处是为真正从朵朵页面运行而补的应用入口修复，超出 #18 文件白名单的字面范围，详见 ADR-0005 实施补记。

默认省略 group_id，与公开客户端关闭圈层筛选时的请求形态一致。不读取用户资料，不硬编码 4；当前 UI 不支持圈层选择。真实召回范围仍需本人确认。新增开发依赖 @types/node 供独立加密测试类型检查，无新增生产依赖。

## 自动验证

- 完整公开 bundle 的 SHA-256、公钥 SHA-256 与现有记录一致；`node frontend/scripts/verify-duo-envelope.mjs /tmp/duo-index-DtY5Q9_f-complete.js` 通过，只做离线互操作。
- adapter 测试以独立 Node/OpenSSL 接收端解密 WebCrypto 请求，并加密合成响应。覆盖信封 round-trip、tag 篡改拒绝、每请求新 key/IV、ddtk、分页快照、字段映射、HTTP 与包壳错误、取消传播。
- 完整合成搜索链路使用实际 DuoSourceSession、SearchSession 与 PlannerClient，验证本地正文匹配和反馈正文不出域。
- 注册朵朵但未登记 manifest 时，既有权限契约测试按预期失败；补齐权限后通过。
- 双站点后台来源校验与未登录 UI 测试通过；未登录时没有模型调用。
- `cd frontend && npm run typecheck`：通过。
- `cd frontend && npm test -- --maxWorkers=2`：12 个文件、124 项测试通过。
- `cd frontend && npm run build`：类型检查、生产构建及扩展产物检查通过。
- `bash -n frontend/scripts/issue-18-19-acceptance-wizard.sh`、可执行位检查、`git diff --check`：通过。
- 用临时 npm stub 验证向导的默认 N、EOF、全部 10 阶段的 12 个确认门、未决项汇总和 --check-only 分支。没有用这次脚本模拟冒充真人验收。

## 仍待本人会话验证

自动测试不证明朵朵服务器接受信封、不证明登录后全文召回与字段形态。没有读取真实认证值或调用搜索 RPC。

向导要求本人在 Edge 检查微信登录、召回与进度、结果卡片、原帖新标签打开、停止与网络错误。以下项目证据不足时保留待验证：

- ddtk 与 duo_session 是否同值。
- 未登录空 entry 是权限、风控还是无匹配。
- needCode 的实际触发条件与阈值；500ms 只是初始策略，不是实测阈值。
- group_id 的圈层语义与默认省略时的搜索范围。
- 真实登录失效与风控提示；不通过高频请求主动触发。

回滚使用本次提交的普通 revert。没有迁移浏览器存储，没有改动原有认证值。

## 双轴审查

Standards 审查无需修复项。Spec 审查未发现功能缺陷，保留一项已说明的范围偏差：后台来源校验和 UI 文案也有改动，不能宣称符合 #18 文件范围限制的字面表述。搜索核心三个文件仍为零 diff。
