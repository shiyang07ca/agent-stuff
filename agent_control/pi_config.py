"""固定四个 Pi 配置文件的校验、生成及安全预览；不运行凭据命令。"""
from __future__ import annotations

import difflib
import hashlib
import ipaddress
import json
import re
import stat
from pathlib import Path
from urllib.parse import urlsplit

from .models import Finding

PI_FILES = ("settings.json", "models.json", "keybindings.json", "modes.json")
# 只列本仓库使用的内置模型，不复制或联网查询宿主的整个目录。
BUILTIN_MODELS = {"deepseek/deepseek-flash"}
LOCAL_SETTINGS = {"lastChangelogVersion", "extensionChangelogVersions"}
THINKING_LEVELS = {"off", "minimal", "low", "medium", "high", "xhigh", "max"}
_SENSITIVE = {"apikey", "headers", "authorization", "password", "secret", "token",
              "accesstoken", "refreshtoken", "credential", "credentials", "clientsecret"}


def _sensitive(key: str) -> bool:
    return key.lower().replace("_", "").replace("-", "") in _SENSITIVE


def _secret_url(value: str) -> bool:
    if not value.startswith(("https://", "http://")):
        return False
    try:
        url = urlsplit(value)
        return bool(url.username or url.password or url.query or url.fragment)
    except ValueError:
        return True


def contains_credentials(value: object) -> bool:
    if isinstance(value, dict):
        return any(_sensitive(key) or contains_credentials(item) for key, item in value.items())
    if isinstance(value, list):
        return any(contains_credentials(item) for item in value)
    return isinstance(value, str) and _secret_url(value)


def redact(value: object) -> object:
    if isinstance(value, dict):
        return {key: "<redacted>" if _sensitive(key) else redact(item)
                for key, item in value.items()}
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, str) and _secret_url(value):
        return "<redacted-url>"
    return value


def json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n").encode()


def _strip_comments(text: str) -> str:
    """逐字符识别 JSON 字符串与转义，仅在字符串外剥离 JSONC 注释。"""
    result: list[str] = []
    index = 0
    quoted = False
    while index < len(text):
        char = text[index]
        if quoted:
            result.append(char)
            index += 1
            if char == "\\" and index < len(text):
                result.append(text[index])
                index += 1
            elif char == '"':
                quoted = False
        elif char == '"':
            quoted = True
            result.append(char)
            index += 1
        elif text.startswith("//", index):
            end = text.find("\n", index + 2)
            index = len(text) if end < 0 else end
            result.append(" ")
        elif text.startswith("/*", index):
            end = text.find("*/", index + 2)
            if end < 0:
                raise ValueError("Unclosed JSONC comment")
            result.append(" " + "\n" * text[index:end + 2].count("\n"))
            index = end + 2
        else:
            result.append(char)
            index += 1
    return "".join(result)


def parse_object(content: bytes, *, jsonc: bool = False) -> dict:
    # 不把解码异常中的片段带到日志：其中可能包含旧文件的凭据。
    try:
        text = content.decode("utf-8")
        if jsonc:
            text = _strip_comments(text)
        def pairs(items):
            result = {}
            for key, value in items:
                if key in result:
                    raise ValueError("Duplicate JSON key")
                result[key] = value
            return result
        def invalid_constant(_value):
            raise ValueError("Non-finite JSON number")
        value = json.loads(text, object_pairs_hook=pairs, parse_constant=invalid_constant)
        if not isinstance(value, dict):
            raise ValueError("Expected JSON object")
        return value
    except (UnicodeError, ValueError, RecursionError):
        raise ValueError("Expected a valid JSON object (content omitted)") from None


def _regular_source(path: Path, repo: Path) -> bytes:
    for parent in (path, *path.parents):
        if parent == repo:
            break
        if parent.is_symlink():
            raise ValueError("Pi source paths must not be symlinks")
    if not stat.S_ISREG(path.stat().st_mode):
        raise ValueError("Pi source must be a regular file")
    return path.read_bytes()


def load_pi_config(repo: Path) -> tuple[dict[str, dict] | None, str, list[Finding]]:
    source = repo / "config/pi"
    package = repo / "pi"
    if not any(path.exists() or path.is_symlink() for path in (source, package)):
        return None, "disabled", []
    digest = hashlib.sha256()
    try:
        config = {}
        for name in PI_FILES:
            raw = _regular_source(source / name, repo)
            digest.update(name.encode() + b"\0" + raw)
            config[name] = parse_object(raw)
            if contains_credentials(config[name]):
                raise ValueError("Shared Pi configuration must not contain credentials or headers")
        raw_package = _regular_source(package / "package.json", repo)
        digest.update(raw_package)
        _validate_package(package, parse_object(raw_package))
        _validate_references(config)
        return config, digest.hexdigest(), []
    except (OSError, ValueError, RuntimeError) as error:
        # 错误说明只来自本模块的固定文案或文件系统，不插入配置值。
        message = str(error) if isinstance(error, ValueError) else "Cannot read complete Pi configuration and package"
        return None, "invalid", [Finding("error", "PI_CONFIG_INVALID", message, "config/pi")]


def _validate_package(package: Path, manifest: dict) -> None:
    resources = manifest.get("pi")
    if not isinstance(manifest.get("name"), str) or not isinstance(resources, dict):
        raise ValueError("Pi package requires a name and pi resource manifest")
    for kind in ("extensions", "skills", "themes", "prompts"):
        patterns = resources.get(kind)
        if not isinstance(patterns, list) or not patterns:
            raise ValueError("Pi package requires extensions, skills, themes and prompts arrays")
        for pattern in patterns:
            if not isinstance(pattern, str) or not pattern or pattern.startswith(("/", "~")) or "\\" in pattern:
                raise ValueError("Pi resource paths must stay within pi/")
            relative = pattern.removeprefix("./")
            if ".." in Path(relative).parts or pattern.startswith(("!", "+", "-")):
                raise ValueError("Pi resource paths must stay within pi/")
            matches = list(package.glob(relative))
            if not matches:
                raise ValueError("Pi resource pattern has no matching files or directories")
            for path in matches:
                if path.is_symlink() or not path.resolve().is_relative_to(package.resolve()):
                    raise ValueError("Pi resource paths must stay within pi/")


def _validate_references(config: dict[str, dict]) -> None:
    providers = config["models.json"].get("providers")
    if not isinstance(providers, dict):
        raise ValueError("models.json requires a providers object")
    available = set(BUILTIN_MODELS)
    for provider, definition in providers.items():
        if not re.fullmatch(r"[A-Za-z0-9_.-]+", provider) or not isinstance(definition, dict):
            raise ValueError("Invalid provider definition")
        models = definition.get("models", [])
        if not isinstance(models, list):
            raise ValueError("Provider models must be an array")
        seen = set()
        for model in models:
            if not isinstance(model, dict) or not isinstance(model.get("id"), str) or not model["id"]:
                raise ValueError("Model requires a non-empty id")
            if model["id"] in seen:
                raise ValueError("Duplicate model id")
            seen.add(model["id"])
            if not isinstance(model.get("api", definition.get("api")), str):
                raise ValueError("Custom model requires an API")
            url = model.get("baseUrl", definition.get("baseUrl"))
            if not isinstance(url, str) or not url.startswith(("http://", "https://")):
                raise ValueError("Custom model requires an HTTP baseUrl")
            available.add(f"{provider}/{model['id']}")

    def reference(value):
        if not isinstance(value, str) or value not in available:
            raise ValueError("Pi model reference is not defined in models.json or the builtin allowlist")

    settings = config["settings.json"]
    if LOCAL_SETTINGS.intersection(settings) or "packages" in settings:
        raise ValueError("Local settings fields and packages must be generated, not shared")
    reference(f"{settings.get('defaultProvider')}/{settings.get('defaultModel')}")
    scoped = settings.get("enabledModels", [])
    if not isinstance(scoped, list):
        raise ValueError("enabledModels must be an array of exact provider/model references")
    for model in scoped:
        reference(model)
    if "webSearch" in settings:
        web_search = settings["webSearch"]
        if not isinstance(web_search, dict) or "model" not in web_search:
            raise ValueError("webSearch requires a model reference")
        reference(web_search["model"])
    if "defaultThinkingLevel" in settings and (
        not isinstance(settings["defaultThinkingLevel"], str)
        or settings["defaultThinkingLevel"] not in THINKING_LEVELS
    ):
        raise ValueError("Invalid default thinking level")
    modes = config["modes.json"]
    definitions = modes.get("modes")
    if modes.get("version") != 1 or not isinstance(definitions, dict) or "default" not in definitions:
        raise ValueError("modes.json requires version 1 and a default mode")
    for mode in definitions.values():
        if not isinstance(mode, dict):
            raise ValueError("Invalid mode definition")
        reference(f"{mode.get('provider')}/{mode.get('modelId')}")
        if not isinstance(mode.get("thinkingLevel"), str) or mode["thinkingLevel"] not in THINKING_LEVELS:
            raise ValueError("Invalid mode thinking level")
    if any(not isinstance(value, (str, list)) or
           (isinstance(value, list) and not all(isinstance(item, str) for item in value))
           for value in config["keybindings.json"].values()):
        raise ValueError("Keybindings must be strings or string arrays")


def generated_config(name: str, source: dict, existing: dict, repo: Path) -> dict:
    result = dict(source)
    if name == "settings.json":
        for key in LOCAL_SETTINGS:
            if key in existing:
                if key == "extensionChangelogVersions":
                    if not isinstance(existing[key], dict) or not all(
                        isinstance(value, str) for value in existing[key].values()
                    ):
                        raise ValueError("Local extension changelog versions must be an object of strings (content omitted)")
                elif not isinstance(existing[key], str):
                    raise ValueError("Local settings runtime fields must be strings (content omitted)")
                result[key] = existing[key]
        result["packages"] = [str(repo / "pi")]
    if name == "modes.json":
        current = existing.get("currentMode", "default")
        result["currentMode"] = current if isinstance(current, str) and current in result["modes"] else "default"
    return result


def local_model_config(source: dict, home: Path) -> dict:
    path = home / ".config" / "agent-stuff" / "local.json"
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return source
    except OSError:
        raise ValueError("Cannot read local.json (content omitted)") from None
    try:
        local = parse_object(raw)
    except ValueError:
        raise ValueError("local.json requires a valid JSON object (content omitted)") from None
    if set(local) != {"providers"} or not isinstance(local["providers"], dict):
        raise ValueError("local.json only supports a providers object")
    providers = dict(source["providers"])
    for provider, override in local["providers"].items():
        if provider not in providers:
            raise ValueError("local.json provider must be defined in config/pi/models.json")
        if not isinstance(override, dict) or set(override) != {"baseUrl"}:
            raise ValueError("local.json provider only supports baseUrl")
        base_url = override["baseUrl"]
        message = "local.json baseUrl requires an HTTP(S) URL without credentials, query or fragment (content omitted)"
        if not isinstance(base_url, str) or not base_url or any(
            character.isspace() or ord(character) < 32 or ord(character) == 127
            for character in base_url
        ) or "\\" in base_url:
            raise ValueError(message)
        try:
            url = urlsplit(base_url)
            # 读取 port 属性会校验可选端口的格式与范围。
            url.port
            if (url.scheme not in {"http", "https"} or not url.hostname
                    or url.username is not None or url.password is not None
                    or url.query or url.fragment):
                raise ValueError(message)
            if url.netloc.startswith("["):
                ipaddress.IPv6Address(url.hostname)
                if not re.fullmatch(r"\[[0-9A-Fa-f:.]+\](?::[0-9]*)?", url.netloc):
                    raise ValueError(message)
            else:
                hostname = url.hostname.encode("idna").decode("ascii").removesuffix(".")
                labels = hostname.split(".")
                if len(hostname) > 253 or any(
                    not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", label)
                    for label in labels
                ):
                    raise ValueError(message)
                if all(label.isdigit() for label in labels):
                    ipaddress.IPv4Address(hostname)
        except ValueError:
            raise ValueError(message) from None
        providers[provider] = {**providers[provider], "baseUrl": base_url}
    return {**source, "providers": providers}


def config_diff(name: str, existing: dict, desired: dict) -> str:
    return "".join(difflib.unified_diff(
        json_bytes(redact(existing)).decode().splitlines(keepends=True),
        json_bytes(redact(desired)).decode().splitlines(keepends=True),
        fromfile=f"local/{name}", tofile=f"generated/{name}"))


def credential_providers(models: dict) -> tuple[str, ...]:
    providers = models.get("providers", {})
    if not isinstance(providers, dict):
        raise ValueError("Existing models providers must be an object (content omitted)")
    result = []
    for provider, config in providers.items():
        if contains_credentials(config):
            if not re.fullmatch(r"[A-Za-z0-9_.-]+", provider):
                raise ValueError("Existing credential provider has an invalid identifier (content omitted)")
            remaining = {key: value for key, value in config.items() if key != "apiKey"} if isinstance(config, dict) else config
            if contains_credentials(remaining):
                raise ValueError("Existing models contain headers or other credentials that provider auth cannot replace; migrate them explicitly before applying (content omitted)")
            result.append(provider)
    return tuple(sorted(result))


def auth_readiness(path: Path, providers: tuple[str, ...]) -> dict[str, bool]:
    """只返回存在可用结构的本机认证；不输出值，不执行命令，不写 auth.json。"""
    if not providers:
        return {}
    try:
        if path.is_symlink() or not stat.S_ISREG(path.stat().st_mode):
            return dict.fromkeys(providers, False)
        # Pi AuthStorage 使用 JSON.parse(stripBom(...))，不接受 models 的 JSONC。
        auth = parse_object(path.read_bytes().removeprefix(b"\xef\xbb\xbf"))
    except (OSError, ValueError):
        return dict.fromkeys(providers, False)
    ready = {}
    for provider in providers:
        credential = auth.get(provider)
        valid = False
        if isinstance(credential, dict):
            if credential.get("type") == "api_key":
                key = credential.get("key")
                valid = isinstance(key, str) and bool(key.strip()) and not key.startswith(("!", "$"))
            elif credential.get("type") == "oauth":
                valid = all(isinstance(credential.get(key), str) and bool(credential[key])
                            for key in ("access", "refresh"))
        ready[provider] = valid
    return ready
