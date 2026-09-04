// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import Home from "./page";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("main menu navigation", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    push.mockReset();
    vi.unstubAllGlobals();
  });

  const renderHome = async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<Home />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const openMenu = async () => {
      const menuButton = container.querySelector<HTMLButtonElement>('button[aria-label="Menu"]');
      expect(menuButton).not.toBeNull();
      await act(async () => {
        menuButton?.click();
      });
    };

    return { container, root, openMenu };
  };

  const stubFetch = () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url === "/api/auth"
        ? { hasPin: false }
        : { featured: [], extra: [], live: [], liveCount: 0 };

      return {
        ok: true,
        json: async () => body,
      } as Response;
    }));
  };

  it("navigates to ranking mode performance when its menu item is clicked", async () => {
    stubFetch();

    const { container, root, openMenu } = await renderHome();

    await openMenu();

    const rankingModeItem = [...container.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')]
      .find((button) => button.textContent?.includes("Ranking Mode Performance"));
    expect(rankingModeItem).toBeDefined();

    await act(async () => {
      rankingModeItem?.click();
    });

    expect(push).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledWith("/performance/modes");
    expect(container.querySelector('[role="menu"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("navigates to tennis predictions when its menu item is clicked", async () => {
    stubFetch();

    const { container, root, openMenu } = await renderHome();

    await openMenu();

    const tennisItem = [...container.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')]
      .find((button) => button.textContent?.includes("Tennis Predictions"));
    expect(tennisItem).toBeDefined();

    await act(async () => {
      tennisItem?.click();
    });

    expect(push).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledWith("/tennis");
    expect(container.querySelector('[role="menu"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });
});
