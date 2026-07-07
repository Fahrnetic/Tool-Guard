import unittest

from toolguard_adapters import CircuitBreaker, adapter_health, scrub_log_value


class PythonAdapterObservabilityTests(unittest.TestCase):
    def test_log_scrubbing_masks_token_assignments(self) -> None:
        self.assertEqual(
            scrub_log_value({"authorization": "placeholder-credential-value"}), {"authorization": "[REDACTED]"}
        )

    def test_adapter_health_and_circuit_breaker_are_explicit(self) -> None:
        health = adapter_health("http://127.0.0.1:3660/api/sidecar/v1/tool-calls")
        breaker = CircuitBreaker(failure_threshold=2)

        breaker.record_failure()
        self.assertEqual(health.status, "configured")
        self.assertFalse(breaker.open)
        breaker.record_failure()
        self.assertTrue(breaker.open)
