import { describe, expect, it } from "vite-plus/test";

import * as ForgejoApi from "../sourceControl/ForgejoApi.ts";
import { forgejoProviderFailure, forgejoViewerPermissions } from "./ForgejoPullRequestProvider.ts";

describe("forgejoProviderFailure", () => {
  it("treats only an HTTP 401 as unusable credentials", () => {
    const responseError = (status: number) =>
      new ForgejoApi.ForgejoResponseError({
        operation: "request",
        status,
        responseBodyLength: 0,
      });

    expect(forgejoProviderFailure(responseError(401)).reason).toBe("unauthenticated");
    expect(forgejoProviderFailure(responseError(403)).reason).toBe("failed");
  });

  it("carries the retry time of an HTTP 429", () => {
    expect(
      forgejoProviderFailure(
        new ForgejoApi.ForgejoResponseError({
          operation: "request",
          status: 429,
          responseBodyLength: 0,
          retryAt: 120_000,
        }),
      ),
    ).toEqual({ reason: "rate-limited", retryAt: 120_000 });
  });
});

describe("forgejoViewerPermissions", () => {
  it("offers every action to credentials with write access", () => {
    expect(forgejoViewerPermissions({ canWrite: true })).toEqual({
      actions: ["merge", "close", "reopen"],
      comment: true,
      resolve: false,
      verdicts: ["comment", "approve", "request-changes"],
      // Forgejo says nothing about who may set a reviewer, and an unreported permission is
      // granted.
      requestReviewers: true,
    });
  });

  it("keeps every action from credentials that can only read the repository", () => {
    expect(forgejoViewerPermissions({ canWrite: false })).toEqual({
      actions: [],
      comment: true,
      resolve: false,
      verdicts: ["comment", "approve", "request-changes"],
      requestReviewers: true,
    });
  });
});
