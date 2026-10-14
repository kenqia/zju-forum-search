# 手动验收

这些向导供开发和回归验证使用。安装与日常搜索步骤见 [README](../README.md)。浏览器验收可能访问当前论坛和已配置模型，请先在原站登录，并使用普通、非敏感查询。若临时调整设置，请在结束前恢复原值。

向导不会读取或保存 API key、Cookie、登录态、认证头、帖子正文或模型响应。需要检查模型请求时，只核对字段名，不记录字段值。无法在真实会话中确认的项目应列为待验证，不能用本地测试结果代替。

| 验收内容 | 运行命令 | 人工检查重点 |
| --- | --- | --- |
| Campus Search UI v2 | `bash frontend/scripts/campus-search-ui-v2-acceptance-wizard.sh` | 重载扩展；检查搜索空态、窄窗口、设置、隐私说明、真实搜索状态和结果列表。 |
| Issue #25，检索波次 | `bash frontend/scripts/issue-25-acceptance-wizard.sh` | 检查真实请求顺序、软隔离、反馈负载和朵朵冒烟。难稳定触发的重判、失败回退和负载上限由自动测试覆盖。 |
| Issue #26，本地预排序 | `bash frontend/scripts/issue-26-acceptance-wizard.sh` | 检查结果分区、增量顺序和卡片内容。 |
| Issue #27，最终列表重排 | `bash frontend/scripts/issue-27-acceptance-wizard.sh` | 检查设置控件、反馈轮、重排状态和取消回退；向导先验证 Top-M、白名单、删除保护和失败回退。 |
| Issue #28，停止与替换 | `bash frontend/scripts/issue-28-acceptance-wizard.sh` | 检查“停止并查看结果”、重排取消和新查询替换。 |
| Issue #30，查询与数据边界 | `bash frontend/scripts/issue-30-acceptance-wizard.sh` | 检查结果卡片、隐私文案和模型请求字段中没有 `author`。 |
| Issue #31，救援与分页 | `bash frontend/scripts/issue-31-acceptance-wizard.sh` | 在登录会话中检查搜索进度、结果保留和终止文案；空候选、请求预留、停止门等由 mock 测试覆盖。 |
| Issue #34，检索事实 | `bash frontend/scripts/issue-34-acceptance-wizard.sh` | 验证 Final Rerank 检索事实、Search Ledger、4000 字节上限和 `clue_only`；真实会话只核对请求字段名。 |
| Issue #35，分支停止 | `bash frontend/scripts/issue-35-acceptance-wizard.sh` | 验证 `stop_queries`、`should_stop`、请求上限和取消行为，并记录真实会话中仍需检查的分页进度。 |
| Issues #18–19，朵朵 | `bash frontend/scripts/issue-18-19-acceptance-wizard.sh` | 按阶段确认登录、搜索、结果跳转和错误提示。侧栏能打开或本地测试通过，不代表检索适配已完成。 |

朵朵向导分 10 个阶段，每阶段用 `y/N` 确认。只运行本地检查时使用：

```bash
bash frontend/scripts/issue-18-19-acceptance-wizard.sh --check-only
```

不需要为复现异常分支高频请求站点或模型。检索行为的实现细节见[检索行为与实现边界](search-behavior.md)。

## MV3 搜索运行生命周期

本流程补充自动测试和 JSDOM 构建检查，验证 Chrome/Edge 实际运行扩展的 service worker。使用独立测试配置文件，加载准备包内的 `dist/`。测试真实论坛或模型前取得相应授权，使用普通查询；不要导出 Network HAR、认证信息或原始请求内容。

先记录浏览器版本、扩展版本、完整构建 commit、站点入口和模型调用方式。执行各项时记录通过、失败或未验证；未复现所需条件的项目记录为未验证。

| 场景 | 操作 | 预期结果 |
| --- | --- | --- |
| 来源初始化期间停止 | 开始搜索，在来源尚未完成初始化时点击停止。必要时只延迟来源初始化请求。 | 界面立即进入运行状态，停止后不继续检索；旧初始化结果不恢复运行。 |
| 两个模型阶段间空闲超过 30 秒 | 仅让一次论坛检索等待 35–45 秒，模型接口保持正常。可用测试浏览器的定向请求拦截工具；若无法定向延迟则记录未验证。等待期间关闭 worker 的 DevTools。 | 同一运行在后续反馈或重排阶段继续使用开始时的模型设置，不因空闲退出而提示运行失效。 |
| 强制终止 worker | 在检索期间从浏览器的 service worker 管理页停止该扩展 worker。Chrome 通常使用 `chrome://serviceworker-internals/`，Edge 使用对应 `edge://` 页面；找不到停止入口则记录未验证。保持论坛页面不刷新。 | 下一模型阶段提示运行失效，不读取新设置继续旧运行。停止或自然结束后的收尾仍尝试释放试用锁；失败可重试。 |
| 免费搜索取消后立即重搜 | 在已授权的 CC98 试用会话中，首轮成功后停止，并尝试立即重搜。等待收尾与额度刷新。 | 原结果保留，下一次免费搜索等待收尾；成功后可重搜。首轮成功后的取消仍计一次额度。 |
| 运行中修改设置 | 在自带 Key 的测试会话中开始搜索，然后修改模型或端点并保存。 | 当前运行继续使用原设置，下一运行使用新设置；只核对调用目标和模型名称，不记录凭据。 |
| 页面入口与离开 | 运行中关闭抽屉、切换设置页，然后离开当前页面。另测浏览器后退恢复页面。 | 关闭抽屉和切换设置页继续运行；离开时停止，迟到响应不覆盖后来发起的新运行；恢复后能重新搜索。 |

打开 worker DevTools 会影响其生命周期，不能以调试窗口一直打开时的结果证明保活有效。空闲场景应在模型阶段之间制造等待，不能把模型接口本身超过 30 秒才返回响应头当作相同场景。

验收结束后恢复网络拦截和模型设置。记录可以使用以下格式，不保存查询、候选内容或凭据：

```text
日期 / 浏览器版本 / 扩展版本 / 完整 commit：
站点入口 / 调用方式：
场景 / 实际等待时长 / 通过、失败或未验证 / 非敏感现象：
设置和网络条件已恢复：是或否
```
