# 发布准备与校验

发布准备只生成本地产物。推送、部署和公开 Release 需要用户明确确认；CI 不部署、不发布。

## 准备产物

环境需要 Node.js 24.16.0、npm、Python 3 和 Git。仓库已有 npm lockfile；Python 只使用标准库，不需要安装包。

1. 在 `frontend/` 运行 `npm ci` 安装锁定依赖。
2. 如需发布扩展新版本，递增 `frontend/public/manifest.json` 的第三段版本号。
3. 提交并审阅修改，按 [审阅范围](review.md) 记录基线和目标。准备脚本要求工作区干净。
4. 在 `frontend/` 运行 `npm run release:prepare`。

准备脚本运行 `npm run check`，包含类型检查、应用测试、发布脚本测试、扩展构建和 relay 构建。检查通过后，在仓库根目录 `dist/releases/v版本号/` 生成：

- `zju-forum-search-v版本号.zip`，只包含 `dist/background.js`、`dist/cc98-webvpn-bridge.js`、`dist/content.js` 和 `dist/manifest.json`。
- `zju-forum-search-relay-v版本号.zip`，只包含 `relay/dist/index.js` 和 `relay/package.json`。
- `release.json`，记录版本、tag、完整 commit SHA 和两个 ZIP 的 SHA-256。

ZIP 会校验文件名单、CRC 和扩展 manifest 版本。产物目录被 Git 忽略；保留本次生成的 `release.json`，发布后用它核对远端。重新准备同一版本会替换本地产物，不能据此覆盖已经公开的 Release。

## 发布与验证

以下命令使用 `v0.3.4` 展示路径形式。下次发布时替换为递增后的版本；先检查远端是否已有该 tag，已发布的版本应保留。

用户确认后先推送代码；如果包含配套 relay 改动，按 [部署说明](../sponsored-trial-deployment.md) 部署并检查健康状态，再公开扩展。创建 Release 时，从 `release.json` 复制完整 commit SHA，替换下面的 `FULL_COMMIT_SHA`。标题以 tag 开头，Release 只上传扩展 ZIP，relay ZIP 留给部署。

```bash
gh release create v0.3.4 ../dist/releases/v0.3.4/zju-forum-search-v0.3.4.zip \
  --target FULL_COMMIT_SHA \
  --title 'v0.3.4 · 搜索运行生命周期与试用收尾' \
  --notes-file /tmp/release-notes.md \
  --draft
```

在公开前核对目标 SHA、发布说明、部署结果及人工验收状态。用户的发布确认仍有效时，公开并核对远端：

```bash
gh release edit v0.3.4 --draft=false --latest
npm run release:verify -- ../dist/releases/v0.3.4/release.json
```

远端验证使用已登录的 `gh`，只读取 Release、tag 和下载包，检查完整 commit、标题、附件名称、下载包 SHA-256、ZIP 文件名单和 manifest 版本；失败则报告不符项，不自动修改远端。`gh` 的认证信息不写入产物。校验不替代 relay 健康检查和真实浏览器验收。

## CI

`.github/workflows/ci.yml` 在推送 `main`、PR 和手动触发时执行相同的 `release:prepare`。使用只读仓库权限，不需要生产密钥。GitHub Actions 只有在工作流推送后才会运行；本地检查通过不等于远端 CI 已通过。

当前 CI 提供检查结果，尚未设置分支保护或 required status checks。修改 GitHub 设置需要另行确认。项目没有独立 lint 命令，本流程复用现有检查。
