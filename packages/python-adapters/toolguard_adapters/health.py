from __future__ import annotations

from dataclasses import dataclass
from time import monotonic


@dataclass
class AdapterHealth:
    status: str
    checked_at_monotonic: float
    sidecar_endpoint: str


class CircuitBreaker:
    def __init__(self, failure_threshold: int = 3) -> None:
        self.failure_threshold = failure_threshold
        self.failures = 0

    @property
    def open(self) -> bool:
        return self.failures >= self.failure_threshold

    def record_success(self) -> None:
        self.failures = 0

    def record_failure(self) -> None:
        self.failures += 1


def adapter_health(sidecar_endpoint: str) -> AdapterHealth:
    return AdapterHealth(
        status="configured" if sidecar_endpoint else "missing-sidecar",
        checked_at_monotonic=monotonic(),
        sidecar_endpoint=sidecar_endpoint,
    )
