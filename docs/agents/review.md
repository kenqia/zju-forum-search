# 代码审阅范围

提交修复后再复审，使审阅目标可用 commit SHA 重现。基线取本次任务开始前的提交，后续复审继续使用同一基线。

## 固定范围

在仓库根目录运行以下命令。将 `BASE_REF` 替换为已确定的基线 commit、tag 或分支；每次复审重新记录 `review_target`。

```bash
review_base=$(git rev-parse 'BASE_REF^{commit}')
review_target=$(git rev-parse HEAD)
git status --short
git diff "$review_base...$review_target" --stat
git log "$review_base..$review_target" --oneline
```

把两个完整 SHA、`git diff "$review_base...$review_target"`、需求来源和标准文档路径交给审阅者。分别记录 Standards 与 Spec 的结论；修复后重新固定目标并复审受影响部分。

工作区中的修改不包含在上述 commit diff 中。确需提前审阅未提交内容时，另附 `git diff HEAD`，并列出 `git ls-files --others --exclude-standard` 的新文件及其内容；报告必须明确这部分范围。确认当前工作区和审阅目标一致后，才记录审阅完成。

## 生命周期改动

涉及 MV3 后台内存、异步请求或跨页面运行归属时，Spec 审阅者检查状态由谁拥有、空闲期间如何存续、终止后如何释放、意外重启后如何恢复或明确失效。对照测试与 [MV3 验收流程](../manual-acceptance.md#mv3-搜索运行生命周期)，分别记录自动测试覆盖和真实浏览器待验证项。
