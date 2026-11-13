# 使用 uv 构建 Python 包

纯 Python 包使用 `uv_build`；包含扩展模块时改用 `hatchling`。

## pyproject.toml

```toml
[project]
name = "my-package"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = []

[build-system]
requires = ["uv_build>=0.9.28,<0.10.0"]
build-backend = "uv_build"
```

## 项目结构

默认布局使用 `src/<package_name>/__init__.py`：

```text
pyproject.toml
src/
└── my_package/
    └── __init__.py
```

包名会被规范化，例如 `Foo-Bar` 变为 `foo_bar`。

### 自定义模块位置

```toml
[tool.uv.build-backend]
module-name = "mymodule"
module-root = ""  # 使用项目根目录，而不是 src/
```

### Namespace package

`foo.bar` namespace 的结构：

```text
src/foo/bar/__init__.py  # foo/ 下不放 __init__.py
```

```toml
[tool.uv.build-backend]
module-name = "foo.bar"
```

## 文件包含与排除

默认排除 `__pycache__`、`*.pyc` 和 `*.pyo`。

```toml
[tool.uv.build-backend]
source-include = ["assets/**"]
source-exclude = ["/dist", "tests/**"]
```

- `include` 模式会锚定路径；`pyproject.toml` 只匹配根目录文件。
- `exclude` 模式默认不锚定；`__pycache__` 会匹配任意同名目录。
- 使用 `/prefix` 可以让 `exclude` 从根目录开始匹配。
