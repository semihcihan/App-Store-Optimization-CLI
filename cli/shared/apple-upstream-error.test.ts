import { normalizeAppleUpstreamError } from "./apple-upstream-error";

function createAxiosError(status: number): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    code: "ERR_BAD_RESPONSE",
    response: { status, data: {} },
  });
}

describe("normalizeAppleUpstreamError", () => {
  it.each([429, 500, 501, 503])(
    "marks exhausted HTTP %i failures as retryable",
    (statusCode) => {
      expect(
        normalizeAppleUpstreamError({
          error: createAxiosError(statusCode),
          operation: "keyword-enrichment",
        })
      ).toEqual(
        expect.objectContaining({
          statusCode,
          retryable: true,
        })
      );
    }
  );

  it("uses the network error code when the message has no transient wording", () => {
    const error = Object.assign(new Error("read failed"), {
      code: "ECONNRESET",
    });

    expect(
      normalizeAppleUpstreamError({
        error,
        operation: "keyword-enrichment",
      })
    ).toEqual(
      expect.objectContaining({
        reasonCode: "ECONNRESET",
        retryable: true,
      })
    );
  });
});
