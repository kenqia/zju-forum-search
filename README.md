# ZJU Forum Search

本地 CC98 论坛语义搜索实验：FastAPI 后端 + React/Vite/TypeScript 前端。

## 启动后端

```bash
cd backend
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python -m app
```

后端默认监听 `http://127.0.0.1:8000`，健康检查为 `GET /api/health`。

## 启动前端

```bash
cd frontend
npm install
npm run dev
```

打开 Vite 地址，在本地界面粘贴用户自己获取的 CC98 access token。token 仅保存在后端进程内存的会话中，不写入日志、配置或仓库。

多请求和外部 LLM 实验默认关闭，可通过后端环境变量显式打开：`ZJU_MULTI_REQUEST_ENABLED=true`、`ZJU_LLM_EXPERIMENT_ENABLED=true`。真实在线测试不在启动或普通单元测试中自动执行。

外部模型实验还需要显式设置本地受信任的 `ZJU_LLM_ENDPOINT`；未设置 endpoint 时不会发起模型调用。模型接口应返回 `{"ordered_ids": ["topic-id", ...]}`。
