# LLM Providers

Multi-provider LLM abstraction with per-provider API key pools.
All providers except `anthropic` share the OpenAI-compatible HTTP interface.

---

## Dataclasses

```python
# bot_engine/components/agent/providers.py
from __future__ import annotations
import os
import json
from dataclasses import dataclass, field
from typing import Any
import httpx
from loguru import logger


@dataclass
class APIKey:
    key: str
    daily_limit: int | None = None  # None = no limit enforced locally


@dataclass
class ProviderConfig:
    name: str
    base_url: str
    model: str
    supports_tools: bool = True
    max_tokens: int = 512
    temperature: float = 0.1
    extra_headers: dict[str, str] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Registry — one entry per provider
# ---------------------------------------------------------------------------
PROVIDER_REGISTRY: dict[str, ProviderConfig] = {
    "groq": ProviderConfig(
        name="groq",
        base_url="https://api.groq.com/openai/v1",
        model="llama-3.3-70b-versatile",
        supports_tools=True,
        max_tokens=512,
    ),
    "gemini": ProviderConfig(
        name="gemini",
        base_url="https://generativelanguage.googleapis.com/v1beta/openai",
        model="gemini-2.0-flash",
        supports_tools=True,
        max_tokens=512,
    ),
    "openrouter": ProviderConfig(
        name="openrouter",
        base_url="https://openrouter.ai/api/v1",
        model="meta-llama/llama-3.3-70b-instruct:free",
        supports_tools=True,
        max_tokens=512,
        extra_headers={"HTTP-Referer": "https://github.com/aldirrss/dev-skills"},
    ),
    "deepseek": ProviderConfig(
        name="deepseek",
        base_url="https://api.deepseek.com/v1",
        model="deepseek-chat",
        supports_tools=True,
        max_tokens=512,
    ),
    "qwen": ProviderConfig(
        name="qwen",
        base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        model="qwen2.5-72b-instruct",
        supports_tools=True,
        max_tokens=512,
    ),
    "openai": ProviderConfig(
        name="openai",
        base_url="https://api.openai.com/v1",
        model="gpt-4o-mini",
        supports_tools=True,
        max_tokens=512,
    ),
    # anthropic handled by AnthropicClient, not this registry
}
```

---

## Unified Response Model

```python
@dataclass
class ToolCall:
    name: str
    arguments: dict[str, Any]
    call_id: str = ""


@dataclass
class LLMResponse:
    tool_calls: list[ToolCall]
    text: str | None
    tokens_used: int = 0
    provider: str = ""
    model: str = ""
```

---

## OpenAI-Compatible Client

Handles all providers in `PROVIDER_REGISTRY`.

```python
class OpenAICompatibleClient:
    def __init__(self, config: ProviderConfig, api_key: str):
        self.config = config
        self.api_key = api_key

    async def chat(
        self,
        messages: list[dict],
        tools: list[dict],          # OpenAI tool format
        tool_choice: str = "required",
    ) -> LLMResponse:
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            **self.config.extra_headers,
        }
        payload: dict[str, Any] = {
            "model": self.config.model,
            "messages": messages,
            "max_tokens": self.config.max_tokens,
            "temperature": self.config.temperature,
        }
        if self.config.supports_tools and tools:
            payload["tools"] = tools
            payload["tool_choice"] = tool_choice

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{self.config.base_url}/chat/completions",
                headers=headers,
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()

        choice = data["choices"][0]
        message = choice["message"]
        usage = data.get("usage", {})
        tokens = usage.get("total_tokens", 0)

        tool_calls: list[ToolCall] = []
        for tc in message.get("tool_calls") or []:
            args = tc["function"]["arguments"]
            tool_calls.append(ToolCall(
                name=tc["function"]["name"],
                arguments=json.loads(args) if isinstance(args, str) else args,
                call_id=tc.get("id", ""),
            ))

        return LLMResponse(
            tool_calls=tool_calls,
            text=message.get("content"),
            tokens_used=tokens,
            provider=self.config.name,
            model=self.config.model,
        )
```

---

## Anthropic Client

Uses the Anthropic SDK. Converts OpenAI tool format → Anthropic tool format internally.

```python
# requires: pip install anthropic
import anthropic as _anthropic


def _openai_tools_to_anthropic(tools: list[dict]) -> list[dict]:
    """Convert OpenAI function-calling format to Anthropic tool format."""
    result = []
    for t in tools:
        fn = t["function"]
        result.append({
            "name": fn["name"],
            "description": fn.get("description", ""),
            "input_schema": fn.get("parameters", {"type": "object", "properties": {}}),
        })
    return result


class AnthropicClient:
    def __init__(self, model: str, api_key: str, max_tokens: int = 512):
        self.model = model
        self.max_tokens = max_tokens
        self._client = _anthropic.AsyncAnthropic(api_key=api_key)

    async def chat(
        self,
        messages: list[dict],
        tools: list[dict],
        tool_choice: str = "required",
    ) -> LLMResponse:
        anthropic_tools = _openai_tools_to_anthropic(tools)

        # Anthropic separates system message
        system = ""
        user_messages = []
        for m in messages:
            if m["role"] == "system":
                system = m["content"]
            else:
                user_messages.append(m)

        resp = await self._client.messages.create(
            model=self.model,
            max_tokens=self.max_tokens,
            system=system,
            messages=user_messages,
            tools=anthropic_tools,
            tool_choice={"type": "any"} if tool_choice == "required" else {"type": "auto"},
        )

        tool_calls: list[ToolCall] = []
        text_parts: list[str] = []
        for block in resp.content:
            if block.type == "tool_use":
                tool_calls.append(ToolCall(
                    name=block.name,
                    arguments=block.input,
                    call_id=block.id,
                ))
            elif block.type == "text":
                text_parts.append(block.text)

        tokens = resp.usage.input_tokens + resp.usage.output_tokens

        return LLMResponse(
            tool_calls=tool_calls,
            text=" ".join(text_parts) or None,
            tokens_used=tokens,
            provider="anthropic",
            model=self.model,
        )
```

---

## AgentConfig Extension

Add to `bot_engine/config.py`:

```python
import os
from pydantic_settings import BaseSettings


class AgentConfig(BaseSettings):
    agent_enabled: bool = True
    agent_provider: str = "groq"
    agent_fallback_chain: list[str] = ["openrouter", "deepseek"]
    agent_pre_signal_threshold: float = 0.4
    agent_passthrough_on_fail: bool = True
    agent_timeout_seconds: int = 20

    # Key pools — loaded dynamically from env: {PROVIDER}_API_KEY_1, _2, _3 ...
    groq_api_keys: list[str] = []
    gemini_api_keys: list[str] = []
    openrouter_api_keys: list[str] = []
    deepseek_api_keys: list[str] = []
    qwen_api_keys: list[str] = []
    openai_api_keys: list[str] = []
    anthropic_api_keys: list[str] = []

    # Anthropic model override (if provider == "anthropic")
    anthropic_model: str = "claude-haiku-4-5-20251001"

    model_config = {"env_file": ".env", "extra": "ignore"}

    def model_post_init(self, __context: object) -> None:
        for provider in ["groq", "gemini", "openrouter", "deepseek", "qwen", "openai", "anthropic"]:
            keys: list[str] = []
            i = 1
            while key := os.getenv(f"{provider.upper()}_API_KEY_{i}"):
                keys.append(key)
                i += 1
            object.__setattr__(self, f"{provider}_api_keys", keys)

    def get_keys(self, provider: str) -> list[str]:
        return getattr(self, f"{provider}_api_keys", [])

    def build_api_keys(self, provider: str) -> list[APIKey]:
        return [APIKey(key=k) for k in self.get_keys(provider)]
```

---

## Client Factory

```python
def build_client(
    provider: str,
    api_key: str,
    agent_config: AgentConfig,
) -> OpenAICompatibleClient | AnthropicClient:
    if provider == "anthropic":
        return AnthropicClient(
            model=agent_config.anthropic_model,
            api_key=api_key,
            max_tokens=512,
        )
    config = PROVIDER_REGISTRY[provider]
    return OpenAICompatibleClient(config=config, api_key=api_key)
```
