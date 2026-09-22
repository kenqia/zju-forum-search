# 用 stop_queries 停止低价值分页分支

状态：已接受

日期：2026-09-22

## 背景

Search Ledger 能告诉反馈模型某个检索词已经请求了多少页、带来了多少候选以及是否仍有 continuation。旧的 `stop_suggestions` 只会把零命中检索词显示为未命中，不能停止有命中的低价值分支。它既没有实现模型建议，也把停止语义错误地绑定到了零命中。

## 决定

反馈协议使用 `stop_queries: [{ query, reason }]`。浏览器先规范化 query 和 reason。空白、重复、类型错误或超出 query 长度边界的条目会逐条丢弃；reason 超长时截断到诊断文本上限。旧字符串 `stop_suggestions` 在兼容期继续读取，但新提示词和测试以 `stop_queries` 为主协议。

SearchSession 只接受同时满足以下条件的 stop query：

- query 匹配本次运行已执行的检索分支；
- 该分支当前仍存在 continuation；
- query 经过本地文本归一化后非空。

匹配使用反馈负载中展示的 query 投影。超过 120 字符的已执行 query 会按同一边界比较；若多个分支具有相同投影，本地拒绝该建议，避免误停。

接受后只从 continuation map 删除目标分支的下一页游标。它不取消已入队首页，不删除其他分支的 continuation，不增加请求计数，不终止搜索，也不影响 `should_stop` 对未来 expansion 的关闭语义。已停止的高命中分支仍属于正常已执行检索词，不会进入零命中 `inactiveSearches`。

`reason` 只作为受限长度的本地诊断字段，不参与接受判断，不进入结果卡片，也不发送到其他请求。

## 取舍

停止 continuation 比维护用户停用词表更符合当前运行模型。建议只影响仍有分页的分支，避免撤销已经完成的请求或干扰其他分支。保留旧字段读取能力可以兼容旧模型响应，但不再把旧字段写入新提示词。

这一决定与 ADR-0009 的 `clue_only` 扩展规则、Search Ledger 和请求上限保持一致。它不改变证据选择、grade 0 翻案名额、救援预留、分页游标保护、请求间隔、用户取消或最终列表重排。
