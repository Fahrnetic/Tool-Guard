from __future__ import annotations

import json
import importlib.util
import threading
import time
import unittest
from contextlib import suppress
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from toolguard_adapters import (
    SIDECAR_PROTOCOL_VERSION,
    Correlation,
    CrewAIToolGuardTool,
    LangGraphToolGuardTool,
    ToolGuardConfig,
    ToolGuardSidecarClient,
)


class SidecarHandler(BaseHTTPRequestHandler):
    responses: list[dict[str, Any]] = []
    requests: list[dict[str, Any]] = []
    delay_seconds = 0.0

    def do_POST(self) -> None:
        length = int(self.headers.get("content-length", "0"))
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        self.__class__.requests.append(payload)
        if self.__class__.delay_seconds:
            time.sleep(self.__class__.delay_seconds)
        response = self.__class__.responses.pop(0)
        body = json.dumps(response).encode("utf-8")
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        with suppress(BrokenPipeError):
            self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:
        return


class FakeSidecar:
    def __init__(self, responses: list[dict[str, Any]], delay_seconds: float = 0.0):
        SidecarHandler.responses = list(responses)
        SidecarHandler.requests = []
        SidecarHandler.delay_seconds = delay_seconds
        ThreadingHTTPServer.allow_reuse_address = True
        self.server = ThreadingHTTPServer(("127.0.0.1", 3666), SidecarHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> "FakeSidecar":
        self.thread.start()
        return self

    def __exit__(self, *args: Any) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    @property
    def requests(self) -> list[dict[str, Any]]:
        return SidecarHandler.requests


def config(adapter_name: str = "toolguard-langgraph", timeout_seconds: float = 1.0) -> ToolGuardConfig:
    return ToolGuardConfig(
        sidecar_endpoint="http://127.0.0.1:3666/api/sidecar/v1/tool-calls",
        timeout_seconds=timeout_seconds,
        harness_id="harness_python_test",
        adapter_id="adapter_python_test",
        harness_name="python-framework-test",
        adapter_name=adapter_name,
    )


class PythonAdapterTests(unittest.TestCase):
    def test_langgraph_wrapper_routes_success_through_sidecar(self) -> None:
        with FakeSidecar(
            [
                {
                    "protocolVersion": SIDECAR_PROTOCOL_VERSION,
                    "status": "success",
                    "result": {
                        "toolName": "fixture.good",
                        "output": {"ok": True, "value": "guarded"},
                        "safeSummary": "Tool fixture.good completed successfully.",
                        "artifactIds": ["artifact_success"],
                    },
                }
            ]
        ) as server:
            tool = LangGraphToolGuardTool("fixture.good", config=config())
            result = tool.invoke({})

        self.assertEqual(result, {"ok": True, "value": "guarded"})
        self.assertEqual(server.requests[0]["protocolVersion"], SIDECAR_PROTOCOL_VERSION)
        self.assertEqual(server.requests[0]["toolName"], "fixture.good")
        self.assertEqual(server.requests[0]["adapterName"], "toolguard-langgraph")
        self.assertEqual(server.requests[0]["harnessId"], "harness_python_test")
        self.assertIn("traceId", server.requests[0]["correlation"])
        self.assertIn("toolCallId", server.requests[0]["correlation"])
        self.assertIn("attemptId", server.requests[0]["correlation"])
        self.assertIn("policyDecisionId", server.requests[0]["correlation"])

    def test_crewai_wrapper_routes_success_through_sidecar(self) -> None:
        with FakeSidecar(
            [
                {
                    "protocolVersion": SIDECAR_PROTOCOL_VERSION,
                    "status": "success",
                    "result": {
                        "toolName": "fixture.good",
                        "output": "crew-result",
                        "safeSummary": "Tool fixture.good completed successfully.",
                        "artifactIds": ["artifact_success"],
                    },
                }
            ]
        ) as server:
            tool = CrewAIToolGuardTool("fixture.good", config=config("toolguard-crewai"))
            result = tool.run(topic="adapter")

        self.assertEqual(result, "crew-result")
        self.assertEqual(server.requests[0]["adapterName"], "toolguard-crewai")
        self.assertEqual(server.requests[0]["arguments"], {"topic": "adapter"})

    def test_sidecar_unavailable_fails_closed_without_direct_execution(self) -> None:
        client = ToolGuardSidecarClient(
            ToolGuardConfig(
                sidecar_endpoint="http://127.0.0.1:3667/api/sidecar/v1/tool-calls",
                timeout_seconds=0.1,
                harness_id="harness_python_test",
                adapter_id="adapter_python_test",
            )
        )
        response = client.call_tool("fixture.good", {"wouldExecuteDirectly": True})

        self.assertEqual(response["status"], "failure")
        self.assertEqual(response["failureCard"]["failureType"], "sidecar_unavailable")
        self.assertTrue(response["failureCard"]["rawDetailsSeparated"])
        self.assertNotIn("wouldExecuteDirectly", response["failureCard"]["safeSummary"])

    def test_malformed_sidecar_response_fails_closed(self) -> None:
        with FakeSidecar([{"protocolVersion": SIDECAR_PROTOCOL_VERSION, "status": "success"}]):
            response = ToolGuardSidecarClient(config()).call_tool("fixture.good", {})

        self.assertEqual(response["status"], "failure")
        self.assertEqual(response["failureCard"]["failureType"], "sidecar_protocol_error")

    def test_incompatible_sidecar_version_fails_closed(self) -> None:
        with FakeSidecar([{"protocolVersion": "toolguard.sidecar.v0", "status": "success", "result": {}}]):
            response = ToolGuardSidecarClient(config()).call_tool("fixture.good", {})

        self.assertEqual(response["status"], "failure")
        self.assertEqual(response["failureCard"]["failureType"], "sidecar_protocol_error")

    def test_timeout_returns_failure_card(self) -> None:
        with FakeSidecar(
            [{"protocolVersion": SIDECAR_PROTOCOL_VERSION, "status": "success", "result": {}}],
            delay_seconds=0.3,
        ):
            response = ToolGuardSidecarClient(config(timeout_seconds=0.05)).call_tool("fixture.slow", {})

        self.assertEqual(response["status"], "failure")
        self.assertEqual(response["failureCard"]["failureType"], "sidecar_unavailable")
        self.assertTrue(response["failureCard"]["rawDetailsSeparated"])

    def test_explicit_correlation_fields_are_preserved_in_protocol_payload(self) -> None:
        with FakeSidecar(
            [
                {
                    "protocolVersion": SIDECAR_PROTOCOL_VERSION,
                    "status": "failure",
                    "failureCard": {
                        "toolName": "fixture.wrong-cwd",
                        "failureType": "cwd_mismatch",
                        "likelyRootCause": "fixture cwd mismatch",
                        "retryable": False,
                        "doNotRetrySameCall": True,
                        "safeRecoveryOptions": ["Use the fixture sandbox cwd."],
                        "humanFix": "Set the fixture cwd.",
                        "evidenceLinks": [{"artifactId": "artifact_failure", "href": "artifacts/failure.txt", "label": "raw"}],
                        "safeSummary": "Tool fixture.wrong-cwd failed with cwd_mismatch.",
                        "rawDetailsSeparated": True,
                    },
                }
            ]
        ) as server:
            correlation = Correlation(
                run_id="run_python",
                trace_id="trace_python",
                harness_id="harness_python",
                adapter_id="adapter_langgraph",
                downstream_server_id="server_fixture",
                tool_call_id="toolcall_python",
                attempt_id="attempt_python",
                policy_decision_id="policy_python",
            )
            response = ToolGuardSidecarClient(config()).call_tool(
                "fixture.wrong-cwd",
                {},
                correlation=correlation,
            )

        self.assertEqual(response["failureCard"]["failureType"], "cwd_mismatch")
        self.assertEqual(
            server.requests[0]["correlation"],
            {
                "runId": "run_python",
                "traceId": "trace_python",
                "harnessId": "harness_python",
                "adapterId": "adapter_langgraph",
                "downstreamServerId": "server_fixture",
                "toolCallId": "toolcall_python",
                "attemptId": "attempt_python",
                "policyDecisionId": "policy_python",
            },
        )

    def test_langgraph_wrapper_accepts_caller_correlation(self) -> None:
        with FakeSidecar(
            [
                {
                    "protocolVersion": SIDECAR_PROTOCOL_VERSION,
                    "status": "success",
                    "result": {
                        "toolName": "fixture.good",
                        "output": "langgraph-correlated",
                        "safeSummary": "Tool fixture.good completed successfully.",
                        "artifactIds": ["artifact_success"],
                    },
                }
            ]
        ) as server:
            correlation = Correlation(
                run_id="run_langgraph",
                trace_id="trace_langgraph",
                parent_id="parent_langgraph",
                harness_id="harness_langgraph",
                adapter_id="adapter_langgraph",
                tool_call_id="toolcall_langgraph",
                attempt_id="attempt_langgraph",
                policy_decision_id="policy_langgraph",
            )
            tool = LangGraphToolGuardTool("fixture.good", config=config())
            result = tool.invoke({}, correlation=correlation)

        self.assertEqual(result, "langgraph-correlated")
        self.assertEqual(server.requests[0]["harnessId"], "harness_langgraph")
        self.assertEqual(server.requests[0]["adapterId"], "adapter_langgraph")
        self.assertEqual(server.requests[0]["correlation"]["runId"], "run_langgraph")
        self.assertEqual(server.requests[0]["correlation"]["traceId"], "trace_langgraph")
        self.assertEqual(server.requests[0]["correlation"]["parentId"], "parent_langgraph")
        self.assertEqual(server.requests[0]["correlation"]["toolCallId"], "toolcall_langgraph")

    def test_crewai_wrapper_accepts_caller_correlation(self) -> None:
        with FakeSidecar(
            [
                {
                    "protocolVersion": SIDECAR_PROTOCOL_VERSION,
                    "status": "success",
                    "result": {
                        "toolName": "fixture.good",
                        "output": "crewai-correlated",
                        "safeSummary": "Tool fixture.good completed successfully.",
                        "artifactIds": ["artifact_success"],
                    },
                }
            ]
        ) as server:
            correlation = Correlation(
                run_id="run_crewai",
                trace_id="trace_crewai",
                harness_id="harness_crewai",
                adapter_id="adapter_crewai",
                tool_call_id="toolcall_crewai",
                attempt_id="attempt_crewai",
                policy_decision_id="policy_crewai",
            )
            tool = CrewAIToolGuardTool("fixture.good", config=config("toolguard-crewai"))
            result = tool.run(correlation=correlation, topic="adapter")

        self.assertEqual(result, "crewai-correlated")
        self.assertEqual(server.requests[0]["harnessId"], "harness_crewai")
        self.assertEqual(server.requests[0]["adapterId"], "adapter_crewai")
        self.assertEqual(server.requests[0]["correlation"]["runId"], "run_crewai")
        self.assertEqual(server.requests[0]["correlation"]["traceId"], "trace_crewai")
        self.assertEqual(server.requests[0]["correlation"]["toolCallId"], "toolcall_crewai")
        self.assertEqual(server.requests[0]["arguments"], {"topic": "adapter"})

    @unittest.skipUnless(importlib.util.find_spec("langgraph"), "optional smoke: install langgraph to run real API check")
    def test_optional_langgraph_smoke_callable_surface(self) -> None:
        with FakeSidecar(
            [
                {
                    "protocolVersion": SIDECAR_PROTOCOL_VERSION,
                    "status": "success",
                    "result": {
                        "toolName": "fixture.good",
                        "output": "langgraph-smoke",
                        "safeSummary": "Tool fixture.good completed successfully.",
                        "artifactIds": ["artifact_success"],
                    },
                }
            ]
        ):
            tool = LangGraphToolGuardTool("fixture.good", config=config())
            self.assertEqual(tool.invoke({}), "langgraph-smoke")

    @unittest.skipUnless(importlib.util.find_spec("crewai"), "optional smoke: install crewai to run real API check")
    def test_optional_crewai_smoke_callable_surface(self) -> None:
        with FakeSidecar(
            [
                {
                    "protocolVersion": SIDECAR_PROTOCOL_VERSION,
                    "status": "success",
                    "result": {
                        "toolName": "fixture.good",
                        "output": "crewai-smoke",
                        "safeSummary": "Tool fixture.good completed successfully.",
                        "artifactIds": ["artifact_success"],
                    },
                }
            ]
        ):
            tool = CrewAIToolGuardTool("fixture.good", config=config("toolguard-crewai"))
            self.assertEqual(tool.run(), "crewai-smoke")

    def test_non_local_endpoint_is_rejected_before_network_use(self) -> None:
        client = ToolGuardSidecarClient(
            ToolGuardConfig(sidecar_endpoint="https://example.com/api/sidecar/v1/tool-calls")
        )
        response = client.call_tool("fixture.good", {})

        self.assertEqual(response["status"], "failure")
        self.assertEqual(response["failureCard"]["failureType"], "sidecar_protocol_error")


if __name__ == "__main__":
    unittest.main()
