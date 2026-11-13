# 三方 Skill 一次只更新到一个明确的 commit

每次更新只处理一个 `.gitmodules` 中声明的目录，并把用户给出的 ref 解析成一个明确的 commit。配置工具不提供批量更新到最新版，也不在 submodule 中合并远端历史。`vendor-apply` 只切换 checkout 并检查仓库；失败时恢复原 checkout，而且不会暂存、提交或启用新的 Skill。需要启用时，另行运行 `make plan` 和 `make apply`。
