# 配置工具只使用 Python 标准库

`agent_control/` 使用 Python 3.11 标准库读取配置、比较文件、复制 Skill、检查本机状态和更新三方来源；Make 命令只调用这套实现。旧 Shell 管理器、TSV 和生成清单已经删除，不再同时维护 Shell 与 Python 两套逻辑，也不新增后台服务、数据库或运行时第三方依赖。
