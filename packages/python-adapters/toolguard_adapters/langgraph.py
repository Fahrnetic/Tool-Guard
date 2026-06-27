from __future__ import annotations

from typing import Any

from .client import Correlation, ToolGuardConfig, ToolGuardSidecarClient


class LangGraphToolGuardTool:
    """Small LangGraph-compatible callable that delegates execution to ToolGuard."""

    def __init__(
        self,
        name: str,
        description: str = "",
        *,
        client: ToolGuardSidecarClient | None = None,
        config: ToolGuardConfig | None = None,
    ):
        self.name = name
        self.description = description
        self._client = client or ToolGuardSidecarClient(
            config
            or ToolGuardConfig(
                adapter_name="toolguard-langgraph",
                harness_name="langgraph",
            )
        )

    def invoke(
        self,
        input: dict[str, Any] | None = None,
        *,
        correlation: Correlation | None = None,
        **kwargs: Any,
    ) -> Any:
        arguments = dict(input or {})
        arguments.update(kwargs)
        response = self._client.call_tool(self.name, arguments, correlation=correlation or Correlation())
        if response.get("status") == "success":
            result = response.get("result", {})
            if isinstance(result, dict):
                return result.get("output", result)
            return result
        return response.get("failureCard", response)

    def __call__(
        self,
        input: dict[str, Any] | None = None,
        *,
        correlation: Correlation | None = None,
        **kwargs: Any,
    ) -> Any:
        return self.invoke(input, correlation=correlation, **kwargs)
