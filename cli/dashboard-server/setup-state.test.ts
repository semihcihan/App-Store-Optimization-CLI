import { jest } from "@jest/globals";
import { createDashboardSetupStateManager } from "./setup-state";

describe("dashboard setup state manager", () => {
  it("supports forced setup even when setup is not otherwise required", async () => {
    let receivedForcePrompt: boolean | undefined;

    const manager = createDashboardSetupStateManager({
      isSetupRequired: () => false,
      resolvePrimaryAppId: async (options) => {
        receivedForcePrompt = options?.forcePrompt;
        return "1234567890";
      },
      onError: jest.fn(),
    });

    expect(manager.start()).toBe(false);
    expect(manager.start({ forcePrompt: true })).toBe(true);
    expect(manager.getState()).toEqual(
      expect.objectContaining({
        status: "in_progress",
        isRequired: true,
      })
    );

    await new Promise((resolve) => setImmediate(resolve));

    expect(receivedForcePrompt).toBe(true);
    expect(manager.getState()).toEqual(
      expect.objectContaining({
        status: "succeeded",
        isRequired: false,
      })
    );
  });
});
