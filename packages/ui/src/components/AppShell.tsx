import type { ReactNode } from "react";
import type { ScreenId } from "../lib/model.js";
import { StatusChip } from "./StatusChip.js";

export interface NavigationItem {
  readonly id: ScreenId;
  readonly label: string;
}

interface AppShellProps {
  readonly active: ScreenId;
  readonly items: readonly NavigationItem[];
  readonly coreState: "connected" | "degraded" | "loading";
  readonly runId: string;
  readonly onSelect: (screen: ScreenId) => void;
  readonly children: ReactNode;
}

export function AppShell({ active, items, coreState, runId, onSelect, children }: AppShellProps) {
  return (
    <div className="min-h-screen text-text">
      <header className="sticky top-0 z-40 border-b border-border/80 bg-bg/85 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
          <a href="#main" className="sr-only focus:not-sr-only focus:rounded-lg focus:bg-bg-panel focus:px-3 focus:py-2">
            Skip to observability content
          </a>
          <div className="flex items-center gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-2xl border border-primary/35 bg-primary/15 text-lg font-black text-primary shadow-lg shadow-primary/10">
              TG
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.35em] text-primary">ToolGuard</p>
              <h1 className="text-xl font-semibold tracking-tight text-text">Cross-harness ToolOps</h1>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip
              label={coreState === "connected" ? "Core API connected" : coreState === "loading" ? "Loading Core API" : "Core API degraded"}
              tone={coreState === "connected" ? "healthy" : coreState === "loading" ? "neutral" : "degraded"}
            />
            <StatusChip label={`runId ${runId}`} tone="selected" />
          </div>
        </div>
        {coreState === "degraded" ? (
          <div className="mx-auto max-w-7xl px-4 pb-3 sm:px-6 lg:px-8" role="status" aria-live="polite">
            <div className="rounded-2xl border border-warning/45 bg-warning/10 px-4 py-3 text-sm leading-6 text-warning">
              Core recovery: check <code className="rounded bg-bg/50 px-1.5 py-0.5">http://127.0.0.1:3660/health</code>,
              restart with <code className="rounded bg-bg/50 px-1.5 py-0.5">TOOLGUARD_CORE_PORT=3660 pnpm dev:core</code>,
              then refresh. Current panels continue to show available cached, empty, or fixture-backed guidance.
            </div>
          </div>
        ) : null}
        <nav className="mx-auto max-w-7xl overflow-x-auto px-4 pb-3 sm:px-6 lg:px-8" aria-label="Primary observability">
          <div className="flex min-w-max gap-2">
            {items.map((item) => {
              const selected = item.id === active;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={selected ? "page" : undefined}
                  aria-pressed={selected}
                  onClick={() => onSelect(item.id)}
                  className={`rounded-xl border px-3 py-2 text-sm font-medium transition hover:border-primary/50 hover:bg-primary/10 hover:text-text active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 ${
                    selected
                      ? "border-primary/45 bg-primary/15 text-primary"
                      : "border-border bg-bg-panel/70 text-text-muted"
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
        </nav>
      </header>
      <main id="main" className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        {children}
      </main>
    </div>
  );
}
