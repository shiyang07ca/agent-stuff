# Agent 说明

本目录是统一工程的 Pi 资源包。共享设置维护在 `../config/pi/`，安装、检查和更新遵循根 `AGENTS.md` 与 `README.md`。下列发布步骤保留作资源包版本维护参考，不代表独立仓库发布或推送授权。

## 发布

1. 运行 `npm version <patch|minor|major> --no-git-tag-version`，确认 `package.json` 和 `package-lock.json` 更新正确；此时不提交、不创建标签。
2. 以上一次发布标签为基准更新 `CHANGELOG.md`，将本次 `Unreleased` 内容整理到新版本章节，保留空的 `Unreleased` 章节。
3. 完成必要验证后，将版本文件和 changelog 一并提交，再在该提交上创建 `v<版本号>` 标签。
4. 推送提交与标签。资源包不作为 npm 公共包发布，未经明确决定不要发布到 npm。

## 扩展

Pi 扩展位于 `./extensions`。在本仓库中新增或更新扩展时统一放在该目录。可以查阅 `pi-mono` 作为参考，但不要修改 `pi-mono` 中的代码。
