import { randomUUID } from "node:crypto";

export type StableId =
  | `run_${string}`
  | `trace_${string}`
  | `parent_${string}`
  | `harness_${string}`
  | `adapter_${string}`
  | `server_${string}`
  | `toolcall_${string}`
  | `attempt_${string}`
  | `policy_${string}`
  | `artifact_${string}`
  | `ledger_${string}`
  | `event_${string}`
  | `report_${string}`;

export function createId(prefix: StableId extends `${infer Prefix}_${string}` ? Prefix : never): StableId {
  return `${prefix}_${randomUUID()}` as StableId;
}
