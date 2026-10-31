/**
 * Model Platform Settings Component Tests
 * @vitest-environment jsdom
 */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ModelPlatformSettings } from "../ModelPlatformSettings";

// Helper to set input value properly for React
const setInputValue = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!
      .set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("ModelPlatformSettings", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  // Mock fetch for all tests
  const mockFetch = vi.fn();
  global.fetch = mockFetch as any;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockFetch.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.removeChild(container);
  });

  const refresh = () =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

  it("renders with disconnected state by default", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        platform: { connected: false },
        providers: [],
        degradations: [],
      }),
    });

    await act(async () => {
      root.render(<ModelPlatformSettings />);
      await refresh();
    });

    const badge = container.querySelector(
      '[data-testid="platform-status-badge"]',
    );
    expect(badge?.textContent).toBe("未连接");
    expect(badge?.className).toContain("bg-neutral-200");
  });

  it("shows connected state when platform is connected", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        platform: { connected: true },
        providers: [],
        degradations: [],
      }),
    });

    await act(async () => {
      root.render(<ModelPlatformSettings />);
      await refresh();
    });

    const badge = container.querySelector(
      '[data-testid="platform-status-badge"]',
    );
    expect(badge?.textContent).toBe("已连接");
    expect(badge?.className).toContain("bg-emerald-100");
  });

  it("allows preset selection", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        platform: { connected: false },
        providers: [],
        degradations: [],
      }),
    });

    await act(async () => {
      root.render(<ModelPlatformSettings />);
      await refresh();
    });

    const select = container.querySelector(
      '[data-testid="platform-preset-select"]',
    ) as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect(select.value).toBe("custom");

    await act(async () => {
      select.value = "local";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await refresh();
    });

    expect(select.value).toBe("local");
    expect(container.textContent).toContain("http://127.0.0.1:8080/v1");
  });

  it("shows custom URL input when custom preset is selected", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        platform: { connected: false },
        providers: [],
        degradations: [],
      }),
    });

    await act(async () => {
      root.render(<ModelPlatformSettings />);
      await refresh();
    });

    const urlInput = container.querySelector(
      '[data-testid="platform-url-input"]',
    );
    expect(urlInput).toBeTruthy();
  });

  it("enables connect button when API key is entered", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        platform: { connected: false },
        providers: [],
        degradations: [],
      }),
    });

    await act(async () => {
      root.render(<ModelPlatformSettings />);
      await refresh();
    });

    const keyInput = container.querySelector(
      '[data-testid="platform-api-key-input"]',
    ) as HTMLInputElement;
    const connectButton = container.querySelector(
      '[data-testid="platform-connect-button"]',
    ) as HTMLButtonElement;

    expect(connectButton.disabled).toBe(true);

    await setInputValue(keyInput, "test-key-123");
    await refresh();

    expect(connectButton.disabled).toBe(false);
  });

  it("handles successful connection", async () => {
    const onConnectionChange = vi.fn();

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          platform: { connected: false },
          providers: [],
          degradations: [],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, connected: true }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          platform: { connected: true },
          providers: [],
          degradations: [],
        }),
      });

    await act(async () => {
      root.render(
        <ModelPlatformSettings onConnectionChange={onConnectionChange} />,
      );
      await refresh();
    });

    const keyInput = container.querySelector(
      '[data-testid="platform-api-key-input"]',
    ) as HTMLInputElement;
    const connectButton = container.querySelector(
      '[data-testid="platform-connect-button"]',
    ) as HTMLButtonElement;

    await setInputValue(keyInput, "valid-key");
    await refresh();

    await act(async () => {
      connectButton.click();
      await refresh();
      await refresh();
    });

    // Verify the validate call was made
    const validateCall = mockFetch.mock.calls.find(
      (call) => call[0] === "/api/credentials/platform/validate",
    );
    expect(validateCall).toBeTruthy();
    expect(validateCall![1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ apiKey: "valid-key" }),
    });

    expect(onConnectionChange).toHaveBeenCalledWith(true);
  });

  it("shows error on connection failure", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          platform: { connected: false },
          providers: [],
          degradations: [],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: false,
          connected: false,
          error: "Invalid API key",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          platform: { connected: false, lastError: "Invalid API key" },
          providers: [],
          degradations: [],
        }),
      });

    await act(async () => {
      root.render(<ModelPlatformSettings />);
      await refresh();
    });

    const keyInput = container.querySelector(
      '[data-testid="platform-api-key-input"]',
    ) as HTMLInputElement;
    const connectButton = container.querySelector(
      '[data-testid="platform-connect-button"]',
    ) as HTMLButtonElement;

    await setInputValue(keyInput, "invalid-key");
    await refresh();

    await act(async () => {
      connectButton.click();
      await refresh();
      await refresh();
    });

    const error = container.querySelector('[data-testid="platform-error"]');
    expect(error).toBeTruthy();
    expect(error!.textContent).toContain("Invalid API key");
  });

  it("allows disconnection when connected", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          platform: { connected: true },
          providers: [],
          degradations: [],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, connected: false }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          platform: { connected: false },
          providers: [],
          degradations: [],
        }),
      });

    await act(async () => {
      root.render(<ModelPlatformSettings />);
      await refresh();
    });

    const disconnectButton = container.querySelector(
      '[data-testid="platform-disconnect-button"]',
    ) as HTMLButtonElement;
    expect(disconnectButton).toBeTruthy();

    await act(async () => {
      disconnectButton.click();
      await refresh();
      await refresh();
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/credentials/platform/disconnect",
      expect.objectContaining({
        method: "POST",
      }),
    );

    const badge = container.querySelector(
      '[data-testid="platform-status-badge"]',
    );
    expect(badge?.textContent).toBe("未连接");
  });

  it("respects disabled prop", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        platform: { connected: false },
        providers: [],
        degradations: [],
      }),
    });

    await act(async () => {
      root.render(<ModelPlatformSettings disabled />);
      await refresh();
    });

    const keyInput = container.querySelector(
      '[data-testid="platform-api-key-input"]',
    ) as HTMLInputElement;
    const connectButton = container.querySelector(
      '[data-testid="platform-connect-button"]',
    ) as HTMLButtonElement;

    expect(keyInput.disabled).toBe(true);
    expect(connectButton.disabled).toBe(true);
  });
});
