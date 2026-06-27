from __future__ import annotations

import json
import socket
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Literal
from uuid import uuid4

from .failure_cards import build_failure_card

SIDECAR_PROTOCOL_VERSION = "toolguard.sidecar.v1"
Idempotency = Literal["idempotent", "non-idempotent", "unknown"]


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:16]}"


@dataclass(frozen=True)
class Correlation:
    run_id: str | None = None
    trace_id: str = field(default_factory=lambda: _new_id("trace"))
    parent_id: str | None = None
    harness_id: str | None = None
    adapter_id: str | None = None
    downstream_server_id: str | None = None
    tool_call_id: str = field(default_factory=lambda: _new_id("toolcall"))
    attempt_id: str = field(default_factory=lambda: _new_id("attempt"))
    policy_decision_id: str = field(default_factory=lambda: _new_id("policy"))

    def to_protocol(self) -> dict[str, str]:
        values = {
            "runId": self.run_id,
            "traceId": self.trace_id,
            "parentId": self.parent_id,
            "harnessId": self.harness_id,
            "adapterId": self.adapter_id,
            "downstreamServerId": self.downstream_server_id,
            "toolCallId": self.tool_call_id,
            "attemptId": self.attempt_id,
            "policyDecisionId": self.policy_decision_id,
        }
        return {key: value for key, value in values.items() if value}


@dataclass(frozen=True)
class ToolGuardConfig:
    sidecar_endpoint: str = "http://127.0.0.1:3660/api/sidecar/v1/tool-calls"
    timeout_seconds: float = 2.0
    harness_id: str = field(default_factory=lambda: _new_id("harness"))
    adapter_id: str = field(default_factory=lambda: _new_id("adapter"))
    harness_name: str = "python-framework"
    adapter_name: str = "toolguard-python-adapter"
    adapter_version: str = "0.0.0"
    protocol_version: str = SIDECAR_PROTOCOL_VERSION

    def validate_local(self) -> None:
        parsed = urllib.parse.urlparse(self.sidecar_endpoint)
        if parsed.scheme not in {"http", "https"}:
            raise ValueError("ToolGuard sidecar endpoint must use http or https")
        host = parsed.hostname
        if host not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError("ToolGuard sidecar endpoint must be local loopback")

    def redacted_observable_config(self) -> dict[str, Any]:
        parsed = urllib.parse.urlparse(self.sidecar_endpoint)
        return {
            "sidecarEndpoint": urllib.parse.urlunparse(
                (parsed.scheme, parsed.netloc, parsed.path, "", "", "")
            ),
            "timeoutSeconds": self.timeout_seconds,
            "harnessId": self.harness_id,
            "adapterId": self.adapter_id,
            "harnessName": self.harness_name,
            "adapterName": self.adapter_name,
            "adapterVersion": self.adapter_version,
            "protocolVersion": self.protocol_version,
        }


class ToolGuardSidecarClient:
    def __init__(self, config: ToolGuardConfig | None = None):
        self.config = config or ToolGuardConfig()

    def call_tool(
        self,
        tool_name: str,
        arguments: dict[str, Any] | None = None,
        *,
        correlation: Correlation | None = None,
        original_tool_name: str | None = None,
        deadline_ms: int | None = None,
        idempotency: Idempotency = "idempotent",
    ) -> dict[str, Any]:
        try:
            self.config.validate_local()
        except ValueError as exc:
            return {"status": "failure", "failureCard": build_failure_card(tool_name, "sidecar_protocol_error", str(exc))}

        selected_correlation = correlation or Correlation(
            harness_id=self.config.harness_id,
            adapter_id=self.config.adapter_id,
        )
        payload = {
            "protocolVersion": self.config.protocol_version,
            "harnessId": selected_correlation.harness_id or self.config.harness_id,
            "adapterId": selected_correlation.adapter_id or self.config.adapter_id,
            "harnessName": self.config.harness_name,
            "adapterName": self.config.adapter_name,
            "adapterVersion": self.config.adapter_version,
            "toolName": tool_name,
            "originalToolName": original_tool_name or tool_name,
            "arguments": arguments or {},
            "deadlineMs": deadline_ms,
            "idempotency": idempotency,
            "correlation": selected_correlation.to_protocol(),
            "observableConfig": self.config.redacted_observable_config(),
        }
        data = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            self.config.sidecar_endpoint,
            data=data,
            headers={"content-type": "application/json", "accept": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.config.timeout_seconds) as response:
                raw = response.read()
        except urllib.error.HTTPError as exc:
            raw = exc.read()
        except (urllib.error.URLError, TimeoutError, socket.timeout, OSError) as exc:
            return {"status": "failure", "failureCard": build_failure_card(tool_name, "sidecar_unavailable", str(exc))}

        try:
            body = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            return {"status": "failure", "failureCard": build_failure_card(tool_name, "sidecar_protocol_error", str(exc))}

        if not isinstance(body, dict):
            return {
                "status": "failure",
                "failureCard": build_failure_card(tool_name, "sidecar_protocol_error", "sidecar response was not an object"),
            }
        if body.get("protocolVersion") != SIDECAR_PROTOCOL_VERSION:
            return {
                "status": "failure",
                "failureCard": build_failure_card(tool_name, "sidecar_protocol_error", "incompatible protocol version"),
            }
        if body.get("status") == "success" and isinstance(body.get("result"), dict):
            return body
        if body.get("status") == "failure" and isinstance(body.get("failureCard"), dict):
            return body
        return {
            "status": "failure",
            "failureCard": build_failure_card(tool_name, "sidecar_protocol_error", "missing result or failureCard"),
        }
