# ADR-0002：可行性后端采用 FastAPI，扩展界面采用 React/Vite

- 状态：部分由 ADR-0003 和 ADR-0004 取代
- 日期：2026-09-05

## 背景

早期可行性实验需要本地网页和后端来验证 CC98 API、认证与候选处理。正式浏览器增强器需要直接运行在 CC98 页面中。

## 决策

- `backend/` 使用 Python 和 FastAPI，曾保留为可行性实验；现已随旧探针一并删除，扩展不依赖本地服务进程。
- 正式界面使用 React、Vite 和 TypeScript，并构建为 Manifest V3 扩展。
- content script 在 closed Shadow DOM 中挂载界面。service worker 保存模型设置并调用用户配置的 OpenAI 兼容端点。
- CC98 检索与本地重排在浏览器中完成。多请求保持串行，遵守 2 秒间隔、搜索时长和请求数上限。
- 外部模型的数据边界与迭代规划由 ADR-0003 和 ADR-0004 记录。

## 影响

- 优点：正式扩展不依赖本地服务进程，仓库只需维护 Node.js 一套开发环境；Python 实验代码已删除。
- 限制：模型端点兼容性需要在 Edge 中单独验证。
