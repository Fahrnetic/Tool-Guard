from __future__ import annotations

import json
import logging
import re
from typing import Any

_SECRET_PATTERNS = [
    re.compile(r"Bearer\s+[A-Za-z0-9._~+/=-]{16,}", re.IGNORECASE),
    re.compile(r"(token|api[_-]?key|secret)=([A-Za-z0-9._~+/=-]{16,})", re.IGNORECASE),
]
_SENSITIVE_KEYS = {"authorization", "token", "api_key", "apikey", "secret", "password"}


def scrub_log_value(value: Any) -> Any:
    if isinstance(value, str):
        scrubbed = value
        for pattern in _SECRET_PATTERNS:
            scrubbed = pattern.sub("[REDACTED]", scrubbed)
        return scrubbed
    if isinstance(value, dict):
        return {
            str(key): "[REDACTED]" if str(key).lower() in _SENSITIVE_KEYS else scrub_log_value(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [scrub_log_value(item) for item in value]
    return value


def log_structured(level: int, message: str, **context: Any) -> None:
    logging.getLogger("toolguard_adapters").log(
        level,
        json.dumps(
            {
                "message": scrub_log_value(message),
                "context": scrub_log_value(context),
            },
            sort_keys=True,
        ),
    )
