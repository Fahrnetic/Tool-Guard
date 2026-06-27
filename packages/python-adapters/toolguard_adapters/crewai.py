from __future__ import annotations

from typing import Any

from .client import Correlation, ToolGuardConfig, ToolGuardSidecarClient


class CrewAIToolGuardTool:
    """Small CrewAI-style tool surface that delegates execution to ToolGuard."""

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
                adapter_name="toolguard-crewai",
                harness_name="crewai",
            )
        )

    def _run(self, **kwargs: Any) -> Any:
        response = self._client.call_tool(self.name, dict(kwargs), correlation=Correlation())
        if response.get("status") == "success":
            result = response.get("result", {})
            if isinstance(result, dict):
                return result.get("output", result)
            return result
        return response.get("failureCard", response)

    def run(self, **kwargs: Any) -> Any:
        return self._run(**kwargs)

    def __call__(self, **kwargs: Any) -> Any:
        return self._run(**kwargs)
