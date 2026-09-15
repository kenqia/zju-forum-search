# #9 模型调用延迟核查

## 范围

本文记录截至 2026-09-15 对阿里云百炼 OpenAI 兼容接口的官方资料核查。重点是 #9 中查询规划与反馈调用的等待、超时和界面状态。没有向用户配置的端点发送请求，也没有读取 API Key。

## 结论

用户设置的 `qwen3.8-max-0902` 是混合思考模型，默认开启思考模式。查询规划只需生成很短的 JSON，不值得承担长思考的时间和 Token 成本。第一优先级应是在 DashScope 请求中显式设置 `enable_thinking: false`，并限制最大输出长度。

这次失败还符合 MV3 service worker 的生命周期限制。Chrome 会终止超过 30 秒才收到响应的 `fetch()`。当前后台使用非流式请求，模型完整生成前 `fetch()` 不会返回，因此百炼允许 300 秒不代表扩展也能等待 300 秒。

搜索时长不应包含模型调用时间。它代表 CC98 检索预算，模型调用应使用独立超时，并在界面上显示阶段和准确的超时原因。否则同一个设置同时控制外部模型和 CC98 检索，用户无法判断时间花在哪里。

流式输出值得做，但它不能返回真实百分比。OpenAI 兼容流只提供生成片段、结束原因和最终用量。界面可以据此显示`正在连接`、`模型已开始生成`和`正在解析计划`，不能声称`已完成 60%`或预测剩余时间。

## 官方资料确认的事实

### 流式输出

- OpenAI 兼容接口支持 `stream: true`，响应使用 SSE，每生成一部分内容就返回一个 chunk。百炼建议使用流式输出来降低长等待造成的超时风险。[流式输出](https://help.aliyun.com/zh/model-studio/stream)
- 中间 chunk 的 `finish_reason` 为 `null`。生成结束时会出现 `finish_reason: "stop"`，之后以 `[DONE]` 结束。[OpenAI 兼容 Chat](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)
- 设置 `stream_options: {"include_usage": true}` 后，Token 用量只在最后一个 chunk 返回。该 chunk 的 `choices` 是空数组，不能按普通内容 chunk 解析。[流式输出](https://help.aliyun.com/zh/model-studio/stream)
- 流式与非流式计费相同。请求中断时，只计算服务端收到终止请求前已经生成的输出 Token。[流式输出](https://help.aliyun.com/zh/model-studio/stream)

### 超时

- 百炼文档说明，非流式调用的最大超时时间不少于 300 秒，实际值随模型和地域变化。超过限制后服务端终止请求。该数值不是客户端应该固定等待 300 秒的承诺。[OpenAI 兼容 Chat](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)
- Chrome 会在 `fetch()` 响应超过 30 秒才到达时终止扩展 service worker。发送长连接消息可以刷新空闲计时器。实现不能依赖一个非流式 `fetch()` 在 MV3 后台等待数分钟。[扩展 service worker 生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- 百炼建议监控首 Token 时间、平均响应时间和错误率。官方没有为 OpenAI 兼容 Chat 提供通用的服务端百分比或预计剩余时间字段。[流式输出](https://help.aliyun.com/zh/model-studio/stream)
- 突发流量可以用 `X-DashScope-Wait-Timeout` 请求服务端排队，但客户端超时必须覆盖排队时间。#9 顺序调用模型，不属于需要优先启用排队的高并发场景。[限流应对最佳实践](https://help.aliyun.com/zh/model-studio/rate-limiting-best-practices)

### 思考模式和模型选择

- `qwen3.8-max` 与 `qwen3.8-max-0902` 默认开启思考模式。[深度思考](https://help.aliyun.com/zh/model-studio/deep-thinking)
- Qwen3.8 默认 `reasoning_effort` 是 `xhigh`，默认 `thinking_budget` 是 131072。`reasoning_effort: "none"` 会映射为 `enable_thinking: false`。[OpenAI 兼容 Chat](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)
- `enable_thinking: false` 可以关闭混合思考模型的思考模式。直接发 HTTP 请求时，这个字段放在请求体顶层。[OpenAI 兼容 Chat](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)
- 百炼的测试显示，思考模式会生成大量额外 Token。关闭后总耗时可降低 60% 到 75%。若保留思考模式，可以用 `thinking_budget` 限制思考长度，也可以流式读取 `reasoning_content`。[深度思考](https://help.aliyun.com/zh/model-studio/deep-thinking)
- 对 `qwen3.8`，`reasoning_effort: "none"` 会映射为关闭思考。`reasoning_effort` 与 `thinking_budget` 不能同时设置。[OpenAI 兼容 Chat](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)
- 百炼把 `qwen3.8-max` 定位为高能力旗舰模型，把 `qwen3.8-flash` 定位为轻量低成本模型，并称 Flash 效果接近旗舰模型。是否满足 #9 的查询计划质量仍需用项目验收集验证，不能由型号说明代替。[文本生成模型](https://help.aliyun.com/zh/model-studio/text-generation-model)

### 结构化输出与流式兼容性

- 流式输出支持 JSON Mode。请求可同时设置 `stream: true` 与 `response_format: {"type": "json_object"}`。客户端拼接全部片段后才能得到有效 JSON。[流式输出](https://help.aliyun.com/zh/model-studio/stream)
- `qwen3.8-max`、`qwen3.8-max-0902` 和 `qwen3.8-flash` 支持 JSON Object 与 JSON Schema。JSON Object 只保证合法 JSON，不保证字段结构。JSON Schema 可以约束字段名和类型。[结构化输出](https://help.aliyun.com/zh/model-studio/qwen-structured-output)
- 流式 JSON 的前几个片段通常不是可独立解析的 JSON。因此流式可以证明连接和生成仍在继续，但不能提前交付完整检索词。

### 端点

- 用户当前使用的 `https://dashscope.aliyuncs.com/compatible-mode/v1` 仍受支持。百炼同时建议北京、新加坡和香港地域迁移到业务空间专属域名，并称新域名能提供更高的性能和稳定性。API Key、模型与域名地域必须匹配。[OpenAI 兼容 Chat](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)

## “模型进度”能显示到什么程度

OpenAI 兼容流没有总 Token 目标、百分比或预计完成时间。`usage` 又只在最后一个 chunk 出现，所以不能从官方字段计算真实进度。

可以显示以下状态：

1. 请求已经发出，正在等待模型响应。
2. 收到第一个 SSE chunk，模型已经开始生成。
3. 持续收到 chunk，并显示已等待秒数。
4. 收到 `finish_reason`，开始拼接并校验 JSON。
5. 计划解析完成，开始 CC98 检索。

如果启用思考模式，`reasoning_content` 能说明模型正在思考，但它不是完成比例。#9 不需要向用户展示思考正文。收到 reasoning chunk 时更新“模型正在规划”状态即可。

## 修复方案

### 方案一：拆分模型时间和检索时间

将“搜索时长”改名为“CC98 检索时长”。计时从首轮计划解析成功后开始，反馈调用期间暂停该计时。项目最终采用统一的 20 秒模型超时；首轮、盲扩展和反馈调用各自独立计时。

这是最符合当前产品语义的修复。用户设置 100 秒时，应得到 100 秒的论坛检索预算，而不是让模型等待吞掉大部分预算。

### 方案二：关闭思考并限制输出

DashScope 请求增加：

```json
{
  "enable_thinking": false,
  "max_completion_tokens": 1200
}
```

首轮和反馈轮都只需要短 JSON。应先用 `qwen3.8-max-0902` 关闭思考做对照验收。如果质量仍满足门槛，再测试 `qwen3.8-flash`。模型切换应保留为设置项，不能把 Flash 写死。

`max_completion_tokens` 的具体值需要根据当前 JSON Schema 和验收样本调整。1200 是实施起点，不是百炼官方推荐值。

### 方案三：改用 SSE 并显示阶段

请求设置 `stream: true` 与 `stream_options: {"include_usage": true}`。后台逐块解析 SSE，通过长连接消息把阶段和计时传给内容脚本。消息也用于刷新 service worker 空闲计时器。完整拼接 `delta.content` 后，再执行 JSON 校验。

界面文案只描述可观测事实，例如`等待首个响应，已用 8 秒`和`模型正在生成计划，已用 19 秒`。不要显示虚构百分比。若 20 到 30 秒仍没有首个 chunk，可以提示`模型响应较慢，仍在等待`，但不要直接改成网络错误。

### 方案四：改善端点与错误诊断

设置页可以提示 DashScope 用户改用与业务空间匹配的专属域名。请求失败时保留以下区别：

- 权限未授予或域名不匹配
- DNS、TLS 或连接失败
- 等待首 chunk 超时
- 流中断
- HTTP 4xx 或 5xx，并保留状态码与不含凭据的服务端错误信息
- 模型返回完成，但 JSON 无法解析
- 用户主动停止

当前`无法连接模型服务，请检查端点和网络`覆盖范围过宽。它把超时、断流和真正的网络失败混成同一种故障，验收时无法定位。

## 最终实施决策

本次同时实施方案一和方案二：模型等待与 CC98 检索预算分离，所有模型调用关闭思考并限制输出。每次模型调用通过 `AbortController` 在 20 秒后终止，超时单独报告；反馈超时保留已取得的结果。

方案三的 SSE 进度不进入本次实现。`qwen3.8-flash` 和业务空间专属域名也不作为默认策略，用户仍可填写所需的 OpenAI 兼容模型与端点。

## 验证建议

对相同的至少 15 条查询记录以下指标：首 chunk 时间、模型完成时间、CC98 检索时间、模型调用次数、停止原因、有效计划率和 Top-5 命中率。比较三组：

1. Max 默认思考，作为当前基线。
2. Max 关闭思考。
3. Flash 关闭思考。

这组对照用于评估固定策略带来的质量和延迟变化，不阻塞本次验收。只有第 3 组质量与第 2 组相当，后续才适合建议用户切换 Flash。
