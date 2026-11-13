# 使用 uv 运行脚本

## 基础用法

```bash
uv run script.py                   # 运行脚本
uv run script.py arg1 arg2         # 传递参数
uv run --python 3.10 script.py     # 指定 Python 版本
echo 'print("hi")' | uv run -      # 从标准输入运行
```

在项目目录中，可以用 `--no-project` 跳过安装当前项目：

```bash
uv run --no-project script.py
```

## 不生成 `__pycache__` 的语法检查

使用 AST parser，不使用 `python -m py_compile`：

```bash
uv run python -m ast script.py >/dev/null
```

## 临时依赖

```bash
uv run --with requests script.py
uv run --with 'requests>2,<3' script.py
uv run --with requests --with rich script.py
```

## 脚本内联元数据

推荐把依赖直接写入脚本：

```python
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "requests<3",
#   "rich",
# ]
# ///

import requests
from rich import print
```

然后直接运行：

```bash
uv run script.py
```

### 管理依赖

```bash
uv init --script example.py --python 3.12
uv add --script example.py requests rich
```

### 使用其他 index

```bash
uv add --index "https://example.com/simple" --script example.py requests
```

会向脚本元数据增加：

```python
# [[tool.uv.index]]
# url = "https://example.com/simple"
```

## 锁定依赖

```bash
uv lock --script example.py  # 创建 example.py.lock
```

## 可复现性

通过日期限制依赖解析范围：

```python
# /// script
# dependencies = ["requests"]
# [tool.uv]
# exclude-newer = "2023-10-16T00:00:00Z"
# ///
```

## 可执行脚本

```python
#!/usr/bin/env -S uv run --script
# /// script
# dependencies = ["httpx"]
# ///

import httpx
print(httpx.get("https://example.com"))
```

```bash
chmod +x myscript
./myscript
```
