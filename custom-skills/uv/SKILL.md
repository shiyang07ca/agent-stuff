---
name: uv
description: "使用 `uv` 管理 Python 项目、脚本、依赖和构建，替代直接调用 `pip`、`python` 与 `venv`。"
---

## 快速参考

```bash
uv run script.py                        # 运行脚本
uv run --with requests script.py        # 临时增加依赖后运行
uv run python -m ast foo.py >/dev/null  # 不生成 __pycache__ 的语法检查
uv add requests                         # 向项目添加依赖
uv init --script foo.py                 # 创建带内联元数据的脚本
```

## 脚本内联依赖

```python
# /// script
# requires-python = ">=3.12"
# dependencies = ["requests"]
# ///
```

脚本运行、锁定和可复现性详见 [scripts.md](scripts.md)。

## 构建后端

纯 Python 包优先使用 `uv_build`：

```toml
[build-system]
requires = ["uv_build>=0.9.28,<0.10.0"]
build-backend = "uv_build"
```

项目结构、namespace package 和文件包含规则详见 [build.md](build.md)。
