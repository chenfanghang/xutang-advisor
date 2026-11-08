"""模型配置的校验与本机保存。"""

import json
import os
from pathlib import Path
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, SecretStr, field_validator


def is_opencode_url(value: str) -> bool:
    """判断官方 OpenCode 服务，避免跨提供商沿用密钥。"""
    parsed = urlsplit(value)
    return parsed.hostname == "opencode.ai"


class ModelSettings(BaseModel):
    """模型服务设置；密钥只用于服务端调用。"""

    model_config = ConfigDict(str_strip_whitespace=True)

    base_url: str = "https://api.deepseek.com"
    model: str = "deepseek-flash"
    api_key: SecretStr = SecretStr("")

    @field_validator("base_url")
    @classmethod
    def validate_base_url(cls, value: str) -> str:
        """服务地址必须是可用于 HTTP 请求的地址。"""
        parts = urlsplit(value)
        if parts.scheme not in {"http", "https"} or not parts.hostname:
            raise ValueError("服务地址须为完整的 http 或 https 地址")
        try:
            _ = parts.port
        except ValueError as error:
            raise ValueError("服务地址的端口须为 0 到 65535 之间的整数") from error
        if parts.username or parts.password or parts.query or parts.fragment:
            raise ValueError("服务地址不能包含账号、密码、查询参数或片段")
        return value.rstrip("/")

    @field_validator("model")
    @classmethod
    def validate_model(cls, value: str) -> str:
        """模型名称不能为空。"""
        if not value:
            raise ValueError("请输入模型名称")
        return value


class SettingsView(BaseModel):
    """供页面显示的配置，不含密钥内容。"""

    base_url: str
    model: str
    api_key_configured: bool


def public_settings(settings: ModelSettings) -> SettingsView:
    """返回可公开给页面的字段。"""
    return SettingsView(
        base_url=settings.base_url,
        model=settings.model,
        api_key_configured=bool(settings.api_key.get_secret_value()),
    )


def read_settings(path: Path, *, include_environment: bool = True) -> ModelSettings:
    """读取已保存配置，首次使用时返回默认值。"""
    settings = (
        ModelSettings.model_validate_json(path.read_text(encoding="utf-8"))
        if path.exists()
        else ModelSettings()
    )
    if (
        include_environment
        and not settings.api_key.get_secret_value()
        and not is_opencode_url(settings.base_url)
    ):
        settings.api_key = SecretStr(os.getenv("DEEPSEEK_API_KEY", "").strip())
    return settings


def resolve_settings(update: ModelSettings, saved: ModelSettings) -> ModelSettings:
    """合并页面提交的设置，空密钥表示沿用已保存值。"""
    key = update.api_key.get_secret_value().strip()
    saved_key = saved.api_key
    if is_opencode_url(update.base_url) != is_opencode_url(saved.base_url):
        saved_key = SecretStr("")
    return ModelSettings(
        base_url=update.base_url,
        model=update.model,
        api_key=SecretStr(key) if key else saved_key,
    )


def save_settings(path: Path, settings: ModelSettings) -> None:
    """保存本机设置；密钥明文仅存在此本机文件中。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.touch(mode=0o600, exist_ok=True)
    path.chmod(0o600)
    path.write_text(
        json.dumps(
            {
                "base_url": settings.base_url,
                "model": settings.model,
                "api_key": settings.api_key.get_secret_value(),
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
