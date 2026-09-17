# SearchSource 接手审查

日期：2026-09-17。接手基线：`72f6185`；T1 审查差异：`git diff 229ce94...72f6185`。依据为 GitHub #10、#12–19、ADR-0004、ADR-0005 和当前代码，附件中的完成声明仅作为待核验记录。

## 结论与范围

保留 adapter/session 分离、源侧分页解释、core 执行预算和限流的方向。core 传回不透明 cursor 并不违背“分页隐藏在 adapter”：隐藏的是 offset、页大小和快照参数，而不是停止请求的控制权。

#10 最新评论明确记录了实测后整体回滚，issue 已关闭。本轮不恢复缓存或“换一组检索词”。CONTEXT 中残留的缓存描述已修正。

#13 已定义端口并替换 SearchSession 的依赖，但原有 44 个测试没有直接覆盖新 session 的响应规范化。Candidate 三层模型、documents 累积、capabilities 提示词属于 #15、#16，不能因尚未落地就否定 T1。

## Standards

独立评审识别了三项问题：

1. 朵朵 `content` 截断后进入 `Candidate.title`，再由白名单发送给模型，违反 ADR-0004 的正文不出域约定。尚未接入朵朵，因此不是当前版本已发生的泄露。
2. 裸数组含 null 时会报错；包壳数组提前过滤坏条目后，会改变位次并把满页误判为末页。本轮已修复并增加四种响应包壳的测试。
3. 损坏 JSON 直接抛 SyntaxError，未知包壳被当作空结果。本轮统一转换为 `SourceError('invalid_response')`，取消异常仍原样传播。

复审未发现这轮 CC98 迁移新增的实质阻塞问题。

## Spec

独立评审确认了上述正文反馈冲突、错误契约和坏条目回归，另指出：

- 空字符串也是端口允许的不透明 cursor，不能用 truthiness 判断分页结束。本轮改为判断 `undefined`，保留相同 cursor 的防重复规则。
- adapter 原有页面/API 声明与 manifest 不一致。本轮统一为 manifest 现有的精确 HTTPS 主机模式，manifest 本身未改。
- 朵朵调研未保留可复核的 bundle 版本、RSA 公钥来源、OAEP hash、编码/IV/tag 细节及协议复现脚本。全文搜索能力与登录后字段仍待验证。不能将这些假设写成已验证事实。

## 本轮接手结果

#14 的本地实现已完成：CC98 代码及测试移到 `sites/cc98/`，UI 经 `sourceRegistry.resolve(location.href)` 创建 session，不读取论坛 token。原有 token 格式、401/403/429 提示、30 次上限、2 秒间隔与每页 20 条保持不变。registry 目前只支持所有已注册站点使用的“精确 origin + 全路径”模式，不宣称支持完整 Chrome match-pattern 语法。

修复 #13 上述响应和 cursor 问题；同步更新 issue-9 验收脚本路径。未安装依赖、未改变 manifest 或认证配置、未进行远端写入。回退可针对本轮本地提交执行普通 revert，原基线仍保留。

## 验证记录

- 修改前：`npm run typecheck`、`npm test` 的 44 个测试、`npm run build` 全通过。
- 新增测试先复现 null 条目、无效 JSON/包壳、空 cursor 的失败，再修复。
- 新增 adapter/session、registry 与 UI 登录提示测试，全部使用合成数据；未读取真实 token 或论坛内容。
- Vitest 默认 forks 在后续运行中出现 worker 启动超时；单线程 threads 池可运行，未修改项目配置。
- 最终验证：`npm run typecheck`、`npm test -- --pool=threads --maxWorkers=1` 的 8 文件/62 测试、`npm run build` 及产物校验全部通过；`bash -n frontend/scripts/issue-9-acceptance-wizard.sh` 和 `git diff --check` 通过。
- 真实 Edge 登录、搜索、限流与原帖跳转尚未手动回归，#14 不应据此声称全部验收完成。

## 后续顺序与待决事项

先完成 #15 的候选分层、#16 的能力提示词和反馈构造、#17 的权限契约测试，再接 #18。#19 的真实会话验收保留给用户操作。

接入朵朵前须解决两点：

- 建议沿用正文不出域约定。正文派生的显示标题只在本地使用；模型反馈必须能区分真实标题与正文派生内容。没有原生标题的来源，应明确反馈可用字段及模型能学习到什么，再修改 ADR/票据。若希望发送正文摘要，这是新的外发范围，需要用户明确批准。
- 补充可复核的传输协议资料和合成响应测试。500ms 间隔只是前次调研的建议，不是已测得的安全阈值；`group_id`、登录后字段及 `needCode` 语义仍需验证。

更改后的 source 允许异步创建，但当前 CC98 同步创建。引入异步 adapter 前，需补“准备中停止/替换/卸载”的生命周期测试，避免晚返回的 source 启动过期搜索。

## 后续进度

上述结论记录接手 #14 时的状态。#15 已继续完成，用户确认保留正文不出域约定；实现、测试和朵朵公开协议复核见 [issue-15 实施记录](../experiments/issue-15-source-model.md)。
