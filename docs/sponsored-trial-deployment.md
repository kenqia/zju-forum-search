# 赞助试用部署

赞助试用于 2026-10-14 启用，入口为 `https://api.kenqia.top`，运行在腾讯云上海轻量服务器。本页供运营者构建、维护和回滚服务。不要在 issue、聊天或命令输出中提供真实 API Key。

## 已完成的服务器准备

2026-10-05 已通过 SSH 核对 Ubuntu 24.04 LTS，并安装独立的 Node.js 24.16.0。安装包按 Node.js 官方 SHASUMS256 校验通过。服务端构建已安装到 `/opt/zju-search/relay/`，`zju-search` systemd 服务已启动并设置开机启动。

`/etc/zju-search/relay.env` 的权限为 root:zju-search `0640`，赞助 Key 由运营者填写。启停开关单独放在 `/etc/zju-search/trial-switch.env`，同样使用 `0640`；systemd drop-in 在主配置之后加载该文件。SQLite 文件位于 `/var/lib/zju-search/trial.sqlite`，由服务用户拥有，权限为 `0600`。

Ubuntu 仓库的 Nginx 1.24.0 监听公网 80/443，服务只监听 `127.0.0.1:8787`。保留的本机检查入口是 `127.0.0.1:8080`。初始 Nginx 配置保留在 `/etc/zju-search/rollback/nginx-initial`，HTTPS 配置之前的站点文件保留在 `/etc/zju-search/rollback/zju-search-public.http-only`。

`api.kenqia.top` 已解析到服务器。用户确认完成备案核对和云防火墙放行；公网 HTTP 验证与 HTTPS 健康检查通过。证书使用 [Certbot webroot 验证](https://eff-certbot.readthedocs.io/en/stable/using.html#webroot)，保存在 `/etc/letsencrypt/live/api.kenqia.top/`。`certbot.timer` 负责续期，`/etc/letsencrypt/renewal-hooks/deploy/zju-search-nginx` 在续期后检查并重载 Nginx。ACME 账号未配置邮件地址。

上线时已验证真实模型的首轮规划、反馈和最终重排，使用合成查询和候选数据，一轮只扣一次体验额度。Certbot 续期演练通过，续期 timer 已启用。273 项自动测试、类型检查、扩展构建和服务端构建均通过。自动测试使用合成模型响应；真实 CC98 登录会话和浏览器中超过 30 秒的响应仍需人工复验。

## v0.3.4 更新记录

2026-10-14，经运营者确认，已部署配套 relay 并发布 [v0.3.4](https://github.com/kenqia/zju-forum-search/releases/tag/v0.3.4)。部署只替换 `dist/index.js` 和 `package.json`，随后重启 `zju-search`；未修改密钥配置、试用开关或 SQLite 账本。部署文件 SHA-256 与本地产物一致，本机及公网 HTTPS `/healthz` 均返回 `{"ok":true}`。本次未重复调用真实模型，健康检查不验证模型或浏览器中的取消流程。

维护入口使用以下 SSH 命令。私钥仅用于本机认证，不上传到服务器或仓库。

```bash
ssh -i ~/.ssh/id_ed25519 root@118.25.26.140
```

旧构建保存在服务器 `/etc/zju-search/rollback/relay-before-v0.3.4-20261014/`。回滚时将其中的 `index.js` 和 `package.json` 恢复到 `/opt/zju-search/relay/dist/index.js` 和 `/opt/zju-search/relay/package.json`，重启服务并检查 `/healthz`；保留现有配置和账本。

## 本地构建

服务端没有新增第三方运行依赖，使用 Node.js 24 的 HTTP、fetch 和 SQLite。构建复用前端的 TypeScript 和 Vite。

```bash
cd frontend
npm ci
npm test
npm run typecheck
npm run build
npm run relay:build
```

服务端产物是 `relay/dist/index.js`，运行时还需要 `relay/package.json`。扩展产物是 `frontend/dist/`。更新部署时只上传构建产物和不含 Key 的模板，保留服务器现有密钥配置和 SQLite 文件。

发布 `v0.3.4` 扩展前先更新配套 relay。新版本的 `/v1/trial/finish` 等待在途调用释放锁后返回，避免用户取消后立即开始的新搜索撞上旧运行锁。旧扩展仍可使用更新后的 relay；本次没有 SQLite 结构迁移。回滚时恢复旧构建并保留账本。

## 服务器准备

先只读检查系统版本、内存、磁盘、Node.js 版本、已有服务、监听端口和防火墙。用户允许移除不再需要的 OpenClaw，不要求保存其数据；不要在不了解现有安装方式时递归删除目录或重装系统。

确认域名在用户账号下，备案已经通过并适用于当前腾讯云服务器。为 `api.kenqia.top` 配置指向服务器的 DNS 记录，安装对应 HTTPS 证书。入口只需公开 443；8787 只监听 loopback。证书更新应能持续自动完成。

Node.js 必须是 24.x。`node:sqlite` 在这个版本仍是实验接口，服务使用的基础 API 已在本地 Node.js 24.16.0 验证。不要在这台服务上启动多个 relay 进程。

## 配置服务

将产物安装到 `/opt/zju-search/relay/`，创建无登录权限的 `zju-search` 系统用户。服务端设置放在 `/etc/zju-search/relay.env`，使用 `relay/.env.example` 作为模板；该文件仅让 root 和服务用户读取，权限设为 `0640`。用服务器上的编辑器填写 API Key，不把真实文件复制到仓库或聊天中。

| 字段 | 含义 |
| --- | --- |
| `TRIAL_ENABLED` | 模板默认 `false`。当前部署由独立的 `trial-switch.env` 覆盖；调整主密钥文件中的此字段不会改变开关。 |
| `MODEL_BASE_URL` | HTTPS OpenAI 兼容 base URL，服务追加 `/chat/completions`。 |
| `MODEL_NAME` | 运营者自选模型 ID，初始使用 `qwen3.8-27b`。 |
| `MODEL_API_KEY` | 仅存在服务器配置中的赞助 Key。 |
| `INPUT_CNY_PER_MILLION`、`OUTPUT_CNY_PER_MILLION` | 每百万 tokens 的人民币费用，必须与供应商实际计费匹配。启用试用时必须显式填写。按可能适用的最高单价预留；价格降低或输入缓存折扣只会使估算更保守。 |
| `DAILY_BUDGET_CNY`、`MONTHLY_BUDGET_CNY` | 默认 20、100，按上海日期和自然月计数。 |
| `SEARCH_BUDGET_CNY` | 单次搜索累计上限，默认 1.5。 |
| `TRIAL_DB_PATH` | 默认 `/var/lib/zju-search/trial.sqlite`；保留此文件才能保留额度和费用记录。 |
| `PORT` | 默认 8787，固定绑定 `127.0.0.1`。 |

启用新模型时，确认它支持 `response_format: json_object`、`enable_thinking: false` 和 `max_completion_tokens`。不兼容时先保持试用关闭；本版不自动猜测参数或切换供应商。参考[百炼 OpenAI 兼容接口](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)。

将 `relay/deploy/zju-search.service` 安装到 systemd。部署使用独立的 `/opt/zju-search/node-v24.16.0-linux-x64/bin/node`，避免依赖登录 shell 中的 Node.js 路径。将 `relay/deploy/40-trial-switch.conf` 安装到 `/etc/systemd/system/zju-search.service.d/`，并创建 `trial-switch.env`，初始值为 `TRIAL_ENABLED=false`。将 `relay/deploy/nginx.conf` 中的 location 放入 `api.kenqia.top` 的 HTTPS server。Nginx 必须关闭响应缓冲，并覆盖 `X-Real-IP`；不要记录访问日志或请求体。随后检查配置并启动服务。

```bash
sudo nginx -t
sudo systemctl daemon-reload
sudo systemctl enable --now zju-search
curl --fail https://api.kenqia.top/healthz
```

健康检查只代表服务进程可访问，不代表赞助 Key、余额或模型可用。

## 上线验收

使用单独的测试浏览器安装扩展。验证新安装不需要 Key 就能在 CC98 发起搜索，首轮、反馈、最终重排均正常；一轮完整搜索只扣一次。用完五次后显示“免费体验额度已用完”和“配置自己的 API Key”，而服务关闭或预算不足显示“免费体验暂不可用”。

分别验证首轮前故障不扣额度、首轮成功后取消仍扣额度、自带 Key 优先、朵朵不能使用赞助 Key，以及超过 30 秒但少于 60 秒的模型响应能在浏览器中完成。最后重启服务，确认旧安装的剩余额度未恢复。

每次调用前服务预留费用，用量返回后再结算；供应商没有返回用量时保留预留值。每次最多输出 1200 tokens，单次搜索最多 32 次模型调用。触及预算会中断后续模型请求，浏览器保留已得到的部分结果。账本不覆盖错误价格、汇率变化或供应商在 tokens 以外收取的费用。

服务只保存匿名凭证哈希、额度、运行计数和汇总费用及错误数。请求内容仍会经过所选供应商，运营者需要核对供应商的数据处理规则。IP 只用于内存中的宽松限速，不作身份识别；每天最多发放 1000 份新资格，避免无成本注册撑满数据库。

首发版本为 `v0.3.3`。每次更新须同步 manifest、tag、Release 标题和 ZIP 名称，ZIP 包含 `dist/`。

## 更换模型与回滚

更换前由运营者在服务器受限目录保留旧配置，部署者保留旧构建产物。不能把真实配置或 Key 写入仓库。先在独立开关文件中关闭试用，再编辑主配置，更换供应商、端点、模型、Key 和人民币单价。修改主配置后重启服务。

关闭试用时运行下面的命令。备份文件只包含开关，不包含 Key。

```bash
sudo cp -p /etc/zju-search/trial-switch.env /etc/zju-search/rollback/trial-switch.env.previous
printf 'TRIAL_ENABLED=false\n' | sudo tee /etc/zju-search/trial-switch.env >/dev/null
sudo systemctl restart zju-search
```

重新启用时设置 `true` 并重启，再用合成查询验证首轮、反馈和重排。验证失败时立即恢复为 `false`。扩展无需更新。

```bash
printf 'TRIAL_ENABLED=true\n' | sudo tee /etc/zju-search/trial-switch.env >/dev/null
sudo systemctl restart zju-search
```

故障时由运营者恢复旧密钥配置，部署者恢复旧构建产物并重启。保留现有 SQLite 文件；不要用删除账本来修复模型配置问题。需要立即暂停时按上面的关闭步骤操作。用户自带 Key 的搜索直接访问用户配置的供应商，不依赖这个服务。
