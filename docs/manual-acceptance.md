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
