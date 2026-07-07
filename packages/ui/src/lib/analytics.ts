import posthog from "posthog-js";

const posthogClient = posthog as unknown as {
  readonly __loaded?: boolean;
  init(key: string, options: { api_host: string; capture_pageview: boolean; autocapture: boolean }): void;
  capture(name: string, properties: Record<string, string | number | boolean>): void;
};

export function initializeProductAnalytics(): void {
  const key = import.meta.env.VITE_POSTHOG_KEY;
  if (!key) return;

  posthogClient.init(key, {
    api_host: import.meta.env.VITE_POSTHOG_HOST ?? "https://us.i.posthog.com",
    capture_pageview: false,
    autocapture: false
  });
}

export function recordUiEvent(name: string, properties: Record<string, string | number | boolean> = {}): void {
  if (!posthogClient.__loaded) return;
  posthogClient.capture(name, properties);
}
