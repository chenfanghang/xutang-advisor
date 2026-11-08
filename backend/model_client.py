"""模型调用及可展示的错误反馈。"""

from uuid import uuid4

from openai import (
    APIConnectionError,
    APIResponseValidationError,
    APIStatusError,
    APITimeoutError,
    AsyncOpenAI,
    AuthenticationError,
    NotFoundError,
    PermissionDeniedError,
    RateLimitError,
)
from openai.types.chat import ChatCompletion, ChatCompletionMessageParam

from backend.settings import ModelSettings, is_opencode_url


class ModelServiceError(Exception):
    """包含 HTTP 状态及用户可处理原因的服务错误。"""

    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


async def complete(
    settings: ModelSettings,
    messages: list[ChatCompletionMessageParam],
    *,
    json_mode: bool = False,
    timeout_seconds: float = 60.0,
) -> str:
    """调用当前模型，不自动重试或泄漏上游错误正文。"""
    key = settings.api_key.get_secret_value()
    if not key:
        raise ModelServiceError(422, "请填写 API Key，或先保存含密钥的配置。")
    headers = None
    if is_opencode_url(settings.base_url):
        headers = {
            "User-Agent": "xutang-advisor/0.1",
            "x-opencode-session": f"ses_{uuid4().hex}",
        }
    try:
        async with AsyncOpenAI(
            api_key=key,
            base_url=settings.base_url,
            timeout=timeout_seconds,
            max_retries=0,
            default_headers=headers,
        ) as client:
            if json_mode:
                response = await client.chat.completions.create(
                    model=settings.model,
                    messages=messages,
                    response_format={"type": "json_object"},
                )
            else:
                response = await client.chat.completions.create(
                    model=settings.model,
                    messages=messages,
                )
    except AuthenticationError as error:
        raise ModelServiceError(400, "认证失败，请检查 API Key。") from error
    except PermissionDeniedError as error:
        raise ModelServiceError(400, "服务拒绝访问，请检查账户和模型权限。") from error
    except NotFoundError as error:
        raise ModelServiceError(
            400, "未找到服务或模型，请检查服务地址和模型名称。"
        ) from error
    except RateLimitError as error:
        raise ModelServiceError(
            429, "服务限流或账户额度不足，请检查账户后重试。"
        ) from error
    except APITimeoutError as error:
        raise ModelServiceError(504, "模型请求超时，请稍后重试。") from error
    except APIConnectionError as error:
        raise ModelServiceError(502, "无法连接模型服务，请检查地址和网络。") from error
    except (APIStatusError, APIResponseValidationError) as error:
        raise ModelServiceError(
            502, "模型服务返回异常，请检查服务配置后重试。"
        ) from error
    if not isinstance(response, ChatCompletion):
        raise ModelServiceError(502, "服务未返回有效的模型响应，请检查服务地址。")
    if not response.choices or not response.choices[0].message.content:
        raise ModelServiceError(502, "服务未返回文本，请检查配置后重试。")
    if response.choices[0].finish_reason == "length":
        raise ModelServiceError(502, "模型回复被截断，请调整输入或模型后重试。")
    text = response.choices[0].message.content.strip()
    if not text:
        raise ModelServiceError(502, "服务返回空白文本，请重试或调整模型。")
    return text
