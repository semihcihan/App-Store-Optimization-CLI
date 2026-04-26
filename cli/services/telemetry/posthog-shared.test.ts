jest.mock("posthog-node", () => ({
  PostHog: jest.fn(() => ({
    identify: jest.fn(),
    capture: jest.fn(),
    shutdown: jest.fn(),
  })),
}));

describe("posthog-shared", () => {
  function getPostHogCtor(): jest.Mock {
    return (jest.requireMock("posthog-node") as { PostHog: jest.Mock }).PostHog;
  }

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it("does not start in development mode", async () => {
    const { initializePostHog, getPostHogClient } = await import(
      "../../shared/telemetry/posthog-shared"
    );
    const PostHog = getPostHogCtor();

    initializePostHog({
      isDevelopment: true,
      apiKey: "phc_test",
    });

    expect(PostHog).not.toHaveBeenCalled();
    expect(getPostHogClient()).toBeNull();
  });

  it("does not start when api key is blank", async () => {
    const { initializePostHog, getPostHogClient } = await import(
      "../../shared/telemetry/posthog-shared"
    );
    const PostHog = getPostHogCtor();

    initializePostHog({
      isDevelopment: false,
      apiKey: "   ",
    });

    expect(PostHog).not.toHaveBeenCalled();
    expect(getPostHogClient()).toBeNull();
  });

  it("starts once without host override when host is not provided", async () => {
    const { initializePostHog, getPostHogClient } = await import(
      "../../shared/telemetry/posthog-shared"
    );
    const PostHog = getPostHogCtor();

    initializePostHog({
      isDevelopment: false,
      apiKey: "phc_test",
    });
    initializePostHog({
      isDevelopment: false,
      apiKey: "phc_test_again",
      host: "https://eu.i.posthog.com",
    });

    expect(PostHog).toHaveBeenCalledTimes(1);
    expect(PostHog).toHaveBeenCalledWith("phc_test");
    expect(getPostHogClient()).toBe(PostHog.mock.results[0]?.value);
  });

  it("passes host override only when provided", async () => {
    const { initializePostHog } = await import(
      "../../shared/telemetry/posthog-shared"
    );
    const PostHog = getPostHogCtor();

    initializePostHog({
      isDevelopment: false,
      apiKey: "phc_test",
      host: "https://eu.i.posthog.com",
    });

    expect(PostHog).toHaveBeenCalledWith("phc_test", {
      host: "https://eu.i.posthog.com",
    });
  });
});
