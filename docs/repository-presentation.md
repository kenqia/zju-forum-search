# 仓库展示整理记录

## 本地改动

- README 面向使用者展示查询示例、真实动图、安装入口、站点支持和隐私摘要。
- 详细参数与操作保留在 `docs/user-guide.md`，通过 `docs/README.md` 导航。
- `llms.txt` 提供英文项目事实与文档入口。它不提供搜索接口，也不保证被外部 AI 收录。
- 封面采用纸白与深蓝，素材来源和最终提示词见 [素材说明](../assets/README.md)。

本次只改文档和展示素材，不修改扩展行为、manifest 版本或发布包，不需要发布扩展新版本。

## 远端只读检查

2026-10-15 通过 `gh` 读取 `kenqia/zju-forum-search` 的状态。

| 项目 | 结果与处理 |
| --- | --- |
| 分支 | 只有 `main`，无需删除遗留分支 |
| 开放 Issue / PR | 均为 0，无待整理条目 |
| Releases | 7 个版本，最新为 `v0.3.4`；保留版本记录与下载包 |
| 仓库简介 | 当前为 `Semantic search for ZJU campus forum posts`，建议改为与领域术语一致的自然语言搜索描述 |
| Topics | 尚未设置，建议补充功能与平台关键词 |
| Homepage | 未设置；目前无独立产品网站，暂留空 |

建议的简介为：

```text
在 CC98 用自然语言找帖子。支持多轮 AI 检索、原帖跳转与 5 次免 Key 体验的浙大社区浏览器扩展。
```

建议的 Topics 为 `cc98`、`zju`、`browser-extension`、`natural-language-search`、`react` 和 `typescript`。

## 已确认的远端操作范围

用户于 2026-10-15 明确确认将本次展示改动提交并更新到远端 `main`，同时更新仓库简介和 Topics。不删除历史 Release、tag、Issue、分支或提交历史，不修改仓库访问权限、hooks 或保护规则。

更新前的旧简介、Topics 和 `main` SHA 保存在本地忽略目录 `dist/repository-presentation-backup/`。需要回滚时，用后续提交恢复文档与素材，并恢复原简介和 Topics，不改写远端历史。

本记录中的新文档链接，在展示改动进入 `main` 后才会在远端生效。

## 本地验证

初次本地审阅时，基线与 HEAD 均为 `b060d8fa4ad2974736912c828fc19b22e02e6c83`，改动位于 `codex/repository-presentation` 的未提交工作区。审阅范围包含 `git diff HEAD` 和本次新增的文档及封面；提交后以该基线到展示提交的差异复核。

- 检查 Markdown 与 HTML 中的相对链接、图片和被引用的标题锚点。
- 对比原 README，确认迁移后的完整安装、设置、工作方式和隐私说明未丢失。
- 使用已有 Chromium 对本地 Markdown 渲染预览进行 1280 px 与 390 px 宽度检查，图片均成功加载，无页面横向溢出、页面错误或 HTTP 错误。
- 执行 `git diff --check` 检查空白问题。

预览采用本地 Markdown 渲染和近似 GitHub 的样式，尚未在远端 GitHub 页面验证。本次没有修改运行代码，未运行应用测试或登录论坛重新搜索；已有演示不构成本次功能验收证据。
