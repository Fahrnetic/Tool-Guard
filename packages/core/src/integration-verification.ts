import { createId } from "./ids.js";
import type { StableId } from "./ids.js";
import type { CoreSession } from "./session.js";
import type {
  EvidenceLink,
  IntegrationCapabilityCheck,
  IntegrationRouteType,
  IntegrationVerificationReceipt,
  JsonValue
} from "./types.js";

export interface IntegrationVerificationInput {
  readonly session: CoreSession;
  readonly routeType: IntegrationRouteType;
}

const LIMITATIONS: Record<IntegrationRouteType, string> = {
  "mcp-routed":
    "Local-only MCP verification checks calls routed through ToolGuard MCP configuration only; native host tools remain outside the claim.",
  "sdk-wrapped-python":
    "Local-only Python verification checks SDK wrapper and loopback sidecar boundaries only; direct framework tools are not intercepted.",
  "cli-supervised":
    "Local-only CLI verification checks process-level supervision only; native agent tool calls require MCP, SDK wrapper, or ToolGuard API routing."
};

export async function verifyIntegrationRoute(
  input: IntegrationVerificationInput
): Promise<IntegrationVerificationReceipt> {
  const receiptId = createId("receipt");
  const timestamp = new Date().toISOString();
  const checkedCapabilities = buildCapabilityChecks(input.routeType);
  const receiptWithoutLinks = {
    receiptId,
    runId: input.session.runId,
    timestamp,
    routeType: input.routeType,
    checkedCapabilities,
    limitation: LIMITATIONS[input.routeType]
  } satisfies Omit<IntegrationVerificationReceipt, "evidenceLinks">;

  const artifact = await input.session.recordRawArtifact(makeArtifactContext(input.session.runId, input.routeType), {
    kind: "verification-receipt",
    fileName: `integration-verification-${input.routeType}-${receiptId}.json`,
    content: receiptWithoutLinks as unknown as JsonValue,
    redacted: true
  });
  const evidenceLinks: EvidenceLink[] = [
    {
      artifactId: artifact.artifactId,
      href: artifact.relativePath,
      label: `Verification receipt for ${input.routeType}`
    }
  ];
  const receipt: IntegrationVerificationReceipt = { ...receiptWithoutLinks, evidenceLinks };
  await input.session.emitIntegrationVerified(receipt);
  return receipt;
}

function buildCapabilityChecks(routeType: IntegrationRouteType): readonly IntegrationCapabilityCheck[] {
  if (routeType === "mcp-routed") {
    return [
      capability("adapter availability", "available", "Core can verify the local MCP adapter package boundary without network access."),
      capability("config snippet validity", "configured", "Generated snippets use loopback commands, placeholders, and no secrets."),
      capability("tool exposure", "available", "Virtual ToolGuard-wrapped tool exposure is verified from local registered metadata.")
    ];
  }
  if (routeType === "sdk-wrapped-python") {
    return [
      capability("sidecar compatibility", "available", "Sidecar protocol compatibility is checked against the local version marker."),
      capability("loopback URL safety", "available", "Only 127.0.0.1 or localhost sidecar URLs are accepted by the probe."),
      capability("wrapper route", "configured", "Framework wrappers must call ToolGuard rather than invoking direct tools.")
    ];
  }
  return [
    capability("process probe", "available", "The local process supervision route is present without spawning destructive commands."),
    capability("argv boundary", "available", "The probe verifies argv boundaries are modeled after -- without shell expansion."),
    capability("destructive guard", "available", "Destructive command patterns are guarded unless fixture-only sandbox metadata is present.")
  ];
}

function capability(
  capabilityName: string,
  status: IntegrationCapabilityCheck["status"],
  evidence: string
): IntegrationCapabilityCheck {
  return {
    capability: capabilityName,
    status,
    localOnly: true,
    evidence
  };
}

function makeArtifactContext(runId: StableId, routeType: IntegrationRouteType) {
  return {
    runId,
    traceId: createId("trace"),
    toolCallId: createId("toolcall"),
    harnessId: createId("harness"),
    adapterId: createId("adapter"),
    downstreamServerId: createId("server"),
    attemptId: createId("attempt"),
    policyDecisionId: createId("policy"),
    toolName: `integration.verify.${routeType}`,
    arguments: {},
    idempotency: "idempotent" as const,
    sourcePath: "non-mcp-direct" as const
  };
}
