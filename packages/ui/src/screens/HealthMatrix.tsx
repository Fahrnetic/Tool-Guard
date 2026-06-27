import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState
} from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { StatePanel } from "../components/StatePanel.js";
import { StatusChip } from "../components/StatusChip.js";
import type { HealthPayload, HealthRow, ResourceStatus } from "../lib/model.js";

interface HealthMatrixProps {
  readonly health?: HealthPayload;
  readonly status: ResourceStatus;
  readonly error?: string;
}

export function HealthMatrix({ health, status, error }: HealthMatrixProps) {
  const [sorting, setSorting] = useState<SortingState>([{ id: "status", desc: false }]);
  const [globalFilter, setGlobalFilter] = useState("");
  const columns = useMemo<ColumnDef<HealthRow>[]>(
    () => [
      { accessorKey: "layer", header: "Layer" },
      { accessorKey: "name", header: "Server / tool" },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => <StatusChip label={row.original.status} tone={toneFor(row.original.status)} />
      },
      { accessorKey: "preflight", header: "Preflight" },
      {
        accessorKey: "latencyMs",
        header: "Latency",
        cell: ({ row }) => <span>{row.original.latencyMs} ms</span>
      },
      { accessorKey: "failureType", header: "Failure type" },
      {
        accessorKey: "retryable",
        header: "Retryability",
        cell: ({ row }) => <span>{row.original.retryable ? "Retryable with policy" : "Do not retry same call"}</span>
      },
      { accessorKey: "circuitState", header: "Circuit" },
      { accessorKey: "remediation", header: "Remediation" }
    ],
    []
  );

  const table = useReactTable({
    data: health ? [...health.rows] : [],
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel()
  });

  if (status === "loading") {
    return <StatePanel status="loading" title="Loading Health Matrix" message="Reading `/api/health` preflight rows from Core." />;
  }
  if (status === "error") {
    return (
      <StatePanel
        status="error"
        title="Health Matrix unavailable"
        message={error ?? "Core did not return the health payload."}
        action="Verify Core is listening on 127.0.0.1:3660."
      />
    );
  }
  if (!health || health.rows.length === 0) {
    return (
      <StatePanel
        status="empty"
        title="No health rows"
        message="No harness, adapter, or downstream tool health rows have been emitted yet."
        action="Run preflight or a demo to fill the matrix."
      />
    );
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-col gap-4 rounded-2xl border border-border bg-bg-elevated/80 p-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <StatusChip label="Tool Server Health Matrix" tone="selected" />
          <h2 className="mt-3 text-2xl font-semibold text-text">Harness, adapter, and downstream health</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-text-muted">
            Sort columns with Enter or Space, filter status and failure fields, and move row focus with Tab. Sticky headers
            preserve context while scanning dense data.
          </p>
        </div>
        <label className="block min-w-72 text-sm font-medium text-text-muted">
          Filter status, failure, layer, or remediation
          <input
            value={globalFilter}
            onChange={(event) => setGlobalFilter(event.target.value)}
            placeholder="degraded, timeout, circuit..."
            className="mt-2 w-full rounded-xl border border-border bg-bg px-3 py-2 text-sm text-text transition placeholder:text-text-dim hover:border-primary/40 focus:border-primary"
          />
        </label>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-bg-panel/90 shadow-2xl shadow-black/20">
        <div className="max-h-[62vh] overflow-auto">
          <table className="min-w-[1120px] w-full border-separate border-spacing-0 text-left text-sm" aria-label="Tool server health matrix">
            <thead className="sticky top-0 z-10 bg-bg-elevated text-xs uppercase tracking-[0.16em] text-text-dim">
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <th key={header.id} className="border-b border-border px-4 py-3 font-semibold">
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            header.column.toggleSorting();
                          }
                        }}
                        className="flex items-center gap-2 rounded-lg px-1 py-1 text-left transition hover:bg-primary/10 hover:text-text active:scale-[0.98]"
                        aria-label={`Sort by ${String(header.column.columnDef.header)}`}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        <span aria-hidden="true">{header.column.getIsSorted() === "asc" ? "↑" : header.column.getIsSorted() === "desc" ? "↓" : "↕"}</span>
                      </button>
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  tabIndex={0}
                  className="group outline-none transition hover:bg-primary/5 focus-visible:bg-primary/10"
                  aria-label={`${row.original.layer} ${row.original.name} status ${row.original.status}, failure type ${row.original.failureType}, circuit ${row.original.circuitState}`}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="border-b border-border/70 px-4 py-3 align-top text-text-muted group-focus-visible:text-text">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function toneFor(status: string): "healthy" | "degraded" | "failed" | "neutral" {
  if (status === "healthy") {
    return "healthy";
  }
  if (status === "failed") {
    return "failed";
  }
  if (status === "degraded") {
    return "degraded";
  }
  return "neutral";
}
