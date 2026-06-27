from __future__ import annotations

from typing import Any


def build_failure_card(tool_name: str, failure_type: str, detail: str) -> dict[str, Any]:
    recovery = {
        "sidecar_unavailable": {
            "likelyRootCause": "The local ToolGuard sidecar endpoint is unavailable.",
            "retryable": True,
            "safeRecoveryOptions": [
                "Start ToolGuard Core on the configured loopback endpoint.",
                "Verify the sidecar URL and timeout configuration.",
            ],
            "humanFix": "Start or repair the local ToolGuard Core sidecar before retrying.",
        },
        "sidecar_protocol_error": {
            "likelyRootCause": "The ToolGuard sidecar response did not match the expected versioned protocol.",
            "retryable": False,
            "safeRecoveryOptions": [
                "Check adapter and sidecar protocol versions.",
                "Inspect sidecar/Core logs before retrying.",
            ],
            "humanFix": "Upgrade the adapter and ToolGuard Core sidecar together.",
        },
    }
    selected = recovery.get(
        failure_type,
        {
            "likelyRootCause": "The ToolGuard adapter failed before a safe result was available.",
            "retryable": False,
            "safeRecoveryOptions": ["Inspect ToolGuard evidence and adapter configuration before retrying."],
            "humanFix": "Repair adapter configuration or sidecar availability.",
        },
    )
    return {
        "toolName": tool_name,
        "failureType": failure_type,
        "likelyRootCause": selected["likelyRootCause"],
        "retryable": selected["retryable"],
        "doNotRetrySameCall": True,
        "safeRecoveryOptions": selected["safeRecoveryOptions"],
        "humanFix": selected["humanFix"],
        "evidenceLinks": [],
        "safeSummary": (
            f"Tool {tool_name} failed with {failure_type}. "
            "Raw details are stored separately in ToolGuard evidence when available. "
            f"Adapter detail: {_safe_detail(detail)}"
        ),
        "rawDetailsSeparated": True,
    }


def _safe_detail(detail: str) -> str:
    compact = " ".join(detail.split())
    if len(compact) > 160:
        return f"{compact[:157]}..."
    return compact
