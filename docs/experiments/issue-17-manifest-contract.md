# #17 Registry 与 manifest 契约验证

日期：2026-09-18。

`frontend/src/extension/source-manifest.test.ts` 读取实际 registry 和 manifest，检查所有 adapter 声明的页面模式与 API 模式分别被 `content_scripts.matches`、`host_permissions` 覆盖。比较采用模式字符串集合包含关系，允许额外权限，不实现 Chrome 通配符解析。

新增 4 个用例，覆盖当前注册源、新源遗漏页面权限、新源遗漏 API 权限，以及跨多个 content script 条目的页面并集和额外模型端点权限。测试使用合成域名，不请求网络、不创建认证 session。

另外临时向实际契约断言的输入分别加入未登记的页面模式与 API 模式。两次单文件运行都按预期失败，错误指出缺失模式；恢复测试文件后 4 项通过。

验证命令与结果：

- `cd frontend && npm run typecheck`：通过。
- `cd frontend && npm test -- src/extension/source-manifest.test.ts`：4 项通过。
- `cd frontend && npm test -- --maxWorkers=2`：9 个文件、81 项通过。
- `cd frontend && npm run build`：类型检查、生产构建与扩展产物检查通过。

未修改 manifest、registry、依赖或运行时代码。
