# 已启用的 Skill 使用独立副本

配置工具会复制所有选定的 Skill，不让 Agent 直接读取 `custom-skills/` 或 `vendors/`。来源文件改变后，必须重新运行 `make plan` 和匹配的 `make apply` 才会启用。当时 94 个 Skill 约占 7 MiB，复制开销很小，换来的是修改来源文件不会意外影响正在使用的版本。
