#!/usr/bin/env bash
# 本人操作 Edge；脚本只运行本地检查、展示步骤并读取 y/N。
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
FRONTEND_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
STAGE_INDEX=0
TOTAL_STAGES=10
PENDING=()

say() { printf '%s\n' "$1"; }
confirm() {
  local reply=''
  printf '%s [y/N] ' "$1"
  read -r reply || return 1
  [[ "$reply" == 'y' || "$reply" == 'Y' ]]
}
require_yes() {
  if ! confirm "$1"; then
    say '验收未完成。请修复或准备好后重新运行；本次不记为通过。'
    exit 1
  fi
}
stage() {
  STAGE_INDEX=$((STAGE_INDEX + 1))
  printf '\n阶段 %s/%s：%s\n' "$STAGE_INDEX" "$TOTAL_STAGES" "$1"
}
record_research() {
  if ! confirm "$1"; then PENDING+=("$2"); fi
}
run_checks() {
  (cd "$FRONTEND_DIR" && npm run typecheck && npm test -- --maxWorkers=2 && npm run build)
}

case "${1:-}" in
  --help|-h)
    say '用法：bash frontend/scripts/issue-18-19-acceptance-wizard.sh [--check-only]'
    say '默认逐阶段确认并由本人操作 Edge；--check-only 只做本地自动验证，不代表真人验收通过。'
    exit 0 ;;
  --check-only)
    run_checks
    say '本地检查通过。Edge 登录、真实搜索和四项调研未决项仍待本人验证。'
    exit 0 ;;
  '') ;;
  *) say '未知参数。使用 --help 查看用法。'; exit 2 ;;
esac

say 'Issue #18 / #19 朵朵校友圈验收'
say '只输入 y 或 N。不要把 token、ddtk、duo_session、API key、正文、请求头或完整响应粘贴到终端。'
say '脚本不读取浏览器数据、不修改登录态或模型设置、不打开网页、不保存会话记录、不写入 GitHub。'

stage '本地构建与自动回归'
say '预期：类型检查、全套测试、生产构建和扩展产物检查通过。加密测试使用临时合成密钥。'
require_yes '现在运行本地检查？'
run_checks
require_yes '本地检查是否全部通过？'

stage '在 Edge 加载扩展'
say "在 Edge 打开 edge://extensions，重载扩展或加载目录：$FRONTEND_DIR/dist"
say 'WSL 用户可在文件资源管理器中打开对应目录；请使用 Edge 的“加载解压缩的扩展”。'
say '打开 https://www.duoduo.link/ 并刷新。预期：右下角有“搜”悬浮球，点击后出现社区自然语言搜索面板。'
say '模型设置只在扩展内填写已授权的端点和 key，不复制到终端。真实查询和允许的元数据会发送给该模型提供方。'
require_yes '扩展已重载、入口可见，且已在界面配置可用模型？'

stage '未登录识别'
say '使用未登录的独立 Edge 配置文件，或已允许本扩展运行的 InPrivate 窗口。不要删除当前正常会话的存储。'
say '在朵朵页面打开扩展并搜索。预期：“请先登录朵朵校友圈，然后刷新页面再试。”'
say '未登录应在创建 source 时停止，不应发起模型请求或朵朵搜索。不要查看或导出认证请求头。'
require_yes '未登录提示正确，且没有继续搜索？'

stage '登录后召回与进度'
say '回到本人正常窗口，在朵朵原站完成微信扫码登录并刷新。登录操作由本人完成。'
say '选一个在原站能命中的普通关键词，再在扩展输入相关自然语言查询。'
say '预期：登录提示消失；检索进度显示轮次、正在执行/已执行词，结果逐轮出现；零命中词标作“未命中检索词”。'
say '当前扩展不限制 group_id，可能与原站开启院校筛选时的结果范围不同；不要据此直接判定排序错误。'
say '预期首轮提示词按全文关键词搜索；若能找到只在正文后半段出现的词，可用它对照验证召回。'
require_yes '本人登录后的搜索有预期召回，进度与全文搜索对照符合预期？'

stage '结果卡片、跳转与停止'
say '预期卡片显示正文截断形成的本地标题、可用板块、时间、回复数，不显示排序分或模型理由。'
say '点击标题，确认原帖在新标签页打开，地址为 https://www.duoduo.link/a/ 对应帖子 ID。'
say '运行中关闭面板再打开，进度应保留；点击“停止并查看结果”，已有结果应保留。'
say '正文与截断标题仅在本地使用，反馈中的 title 应为空；该隐私边界已由合成链路测试检查，不导出真实模型请求。'
require_yes '结果卡片、原帖新标签和停止行为是否符合预期？'

stage '错误文案与恢复'
say '本地测试已覆盖 status=10000 登录失效、needCode=true 限流、HTTP 401/403/429、网络错误和损坏响应。'
say '真实会话若自然出现登录失效，预期提示重新登录；若自然出现风控，预期提示在原站完成验证并保留已有结果。'
say '不要为了验收高频发送请求或主动触发风控。未自然出现的真实错误仍列为待验证。'
say '可在浏览器 DevTools 临时切换 Offline 后尝试一次搜索，再恢复 Online；应显示可读中文错误，不出现原始服务端数据。'
require_yes '自动错误测试已通过，网络错误可读且恢复 Online 后能继续使用？'
record_research '本人会话是否自然出现并核对过登录失效与风控两种提示？' '真实登录失效与风控提示'

stage '未决项：ddtk 与 duo_session 的关系'
say '仅在本人会话内、已有可信调试手段时核对两者是否同值；只在私有笔记记录“同值/不同/无法确认”，不记录实际值。'
say '不要展开给他人、截图、复制或导出任一认证值；没有安全比较方式就回答 N，保持待验证。'
record_research '是否已在本人会话确认两者关系，并只记录了结论？' 'ddtk 与 duo_session 是否同值'

stage '未决项：未登录 entry 为空的含义'
say '扩展未登录会直接停止，因此不能靠扩展验证服务器未登录搜索行为。'
say '如原站允许，在本人正常窗口和独立未登录窗口用同一个已知可命中的词各做一次对照。不要修改或伪造凭据。'
say '空结果本身不能区分风控、权限或无匹配；只有明确响应说明或平台文档才足以确认原因，否则回答 N。'
record_research '是否已有证据区分未登录空 entry 的原因，并只记录非敏感结论？' '未登录空 entry 的服务端含义'

stage '未决项：needCode 与限流阈值'
say '只记录自然出现的 needCode/验证码提示或平台公布的规则，不用压测探测阈值。'
say '当前 500ms 间隔、最多 30 次调用来自票据，是初始策略，不是实测安全阈值。'
say '如果只验证了合成 needCode=true 的错误映射，尚不能确认服务器触发条件，应回答 N。'
record_research '是否有真实响应或平台规则证据确认 needCode 条件与阈值？' 'needCode 触发条件和实际阈值'

stage '未决项：group_id 与搜索范围'
say '在原站使用同一关键词，对照圈层筛选开启/关闭时的结果和页面说明。'
say '扩展当前省略 group_id，不读取用户资料、不默认指定 4；不能宣称与原站个人圈层筛选等价。'
say '仅记录可公开的圈层语义与范围差异；不要复制完整用户对象、帖子正文或响应。证据不足时回答 N。'
record_research '是否已在本人会话确认 group_id 对搜索范围的影响？' 'group_id 圈层语义与范围'

printf '\n'
say '基础交互验收已完成。脚本没有保存任何会话材料。'
if (( ${#PENDING[@]} )); then
  say '以下真实会话项目仍待验证，不能将本次记为全部验收通过：'
  printf '  - %s\n' "${PENDING[@]}"
else
  say '各阶段均由验收者确认。请在自己的验收记录中保留非敏感结论与日期。'
fi
