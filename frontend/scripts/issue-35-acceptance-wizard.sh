#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
FRONTEND_DIR=$(cd "$SCRIPT_DIR/.." && pwd)

printf '%s\n' 'Issue #35 stop_queries continuation 协议验收'
printf '%s\n' '本脚本只运行本地测试、类型检查和构建，不读取认证信息或模型请求。'

(cd "$FRONTEND_DIR" && \
  npm test && \
  npm run typecheck && \
  npm run build)

grep -nF 'stop_queries' "$FRONTEND_DIR/src/extension/planner.ts" >/dev/null
grep -nF 'continuations.delete' "$FRONTEND_DIR/src/extension/search-session.ts" >/dev/null
grep -nF '检索词停止建议' "$FRONTEND_DIR/../CONTEXT.md" >/dev/null
grep -nF '反馈协议使用' "$FRONTEND_DIR/../docs/adr/0010-query-stop-continuation-control.md" >/dev/null

printf '%s\n' 'Issue #35 本地验收通过。真实登录会话的分页进度仍需人工检查。'
