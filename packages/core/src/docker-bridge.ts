import { spawnSync } from "node:child_process";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

export interface DockerBridgeMetricsBinding {
  readonly host: string;
  readonly interfaceName: string;
}

export function discoverDockerBridgeMetricsBindings(
  interfaces: NodeJS.Dict<readonly NetworkInterfaceInfo[]> = networkInterfaces(),
  ipAddrOutput = readIpAddrOutput()
): readonly DockerBridgeMetricsBinding[] {
  const bindings: DockerBridgeMetricsBinding[] = [];
  const seen = new Set<string>();

  for (const [interfaceName, addresses] of Object.entries(interfaces)) {
    if (!interfaceName || !addresses || !isDockerBridgeInterfaceName(interfaceName)) continue;
    for (const address of addresses) {
      if (address.family !== "IPv4" || address.internal || !isPrivateDockerBridgeAddress(address.address)) continue;
      if (seen.has(address.address)) continue;
      seen.add(address.address);
      bindings.push({ host: address.address, interfaceName });
    }
  }

  for (const binding of parseIpAddrDockerBridgeBindings(ipAddrOutput)) {
    if (seen.has(binding.host)) continue;
    seen.add(binding.host);
    bindings.push(binding);
  }

  return bindings;
}

export function parseIpAddrDockerBridgeBindings(output: string): readonly DockerBridgeMetricsBinding[] {
  const bindings: DockerBridgeMetricsBinding[] = [];
  const seen = new Set<string>();

  for (const line of output.split("\n")) {
    const match = line.match(/^\d+:\s+(?<interfaceName>\S+)\s+inet\s+(?<address>\d+\.\d+\.\d+\.\d+)\//);
    const interfaceName = match?.groups?.interfaceName;
    const address = match?.groups?.address;
    if (!interfaceName || !address || !isDockerBridgeInterfaceName(interfaceName) || !isPrivateDockerBridgeAddress(address)) continue;
    if (seen.has(address)) continue;
    seen.add(address);
    bindings.push({ host: address, interfaceName });
  }

  return bindings;
}

function readIpAddrOutput(): string {
  const result = spawnSync("ip", ["-o", "-4", "addr", "show"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout : "";
}

function isDockerBridgeInterfaceName(interfaceName: string): boolean {
  return interfaceName === "docker0" || interfaceName.startsWith("br-");
}

function isPrivateDockerBridgeAddress(address: string): boolean {
  const octets = address.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [first, second] = octets;
  if (first === undefined || second === undefined) return false;

  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}
