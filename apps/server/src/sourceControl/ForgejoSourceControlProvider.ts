import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { SourceControlProviderError, type ChangeRequest } from "@t3tools/contracts";

import * as ForgejoApi from "./ForgejoApi.ts";
import type { NormalizedForgejoPullRequestRecord } from "./forgejoPullRequests.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import type { SourceControlApiDiscoverySpec } from "./SourceControlProviderDiscovery.ts";

function toChangeRequest(summary: NormalizedForgejoPullRequestRecord): ChangeRequest {
  return {
    provider: "forgejo",
    number: summary.number,
    title: summary.title,
    url: summary.url,
    baseRefName: summary.baseRefName,
    headRefName: summary.headRefName,
    state: summary.state,
    updatedAt: summary.updatedAt ?? Option.none(),
    ...(summary.isCrossRepository !== undefined
      ? { isCrossRepository: summary.isCrossRepository }
      : {}),
    ...(summary.headRepositoryNameWithOwner !== undefined
      ? { headRepositoryNameWithOwner: summary.headRepositoryNameWithOwner }
      : {}),
    ...(summary.headRepositoryOwnerLogin !== undefined
      ? { headRepositoryOwnerLogin: summary.headRepositoryOwnerLogin }
      : {}),
  };
}

export const make = Effect.gen(function* () {
  const forgejo = yield* ForgejoApi.ForgejoApi;

  return SourceControlProvider.SourceControlProvider.of({
    kind: "forgejo",
    listChangeRequests: (input) => {
      const source = SourceControlProvider.sourceControlRefFromInput(input);
      return forgejo
        .listPullRequests({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
          headSelector: input.headSelector,
          ...(source ? { source } : {}),
          state: input.state,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        })
        .pipe(
          Effect.map((items) => items.map(toChangeRequest)),
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "forgejo",
                operation: "listChangeRequests",
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.headSelector,
                ),
                detail: "Failed to list change requests.",
                cause: error,
              }),
          ),
        );
    },
    getChangeRequest: (input) =>
      forgejo.getPullRequest(input).pipe(
        Effect.map(toChangeRequest),
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "forgejo",
              operation: "getChangeRequest",
              cwd: input.cwd,
              reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.reference,
              ),
              detail: "Failed to get change request.",
              cause: error,
            }),
        ),
      ),
    createChangeRequest: (input) => {
      const source = SourceControlProvider.sourceControlRefFromInput(input);
      return forgejo
        .createPullRequest({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
          baseBranch: input.baseRefName,
          headSelector: input.headSelector,
          ...(source ? { source } : {}),
          ...(input.target ? { target: input.target } : {}),
          title: input.title,
          bodyFile: input.bodyFile,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "forgejo",
                operation: "createChangeRequest",
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.headSelector,
                ),
                detail: "Failed to create change request.",
                cause: error,
              }),
          ),
        );
    },
    getRepositoryCloneUrls: (input) =>
      forgejo.getRepositoryCloneUrls(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "forgejo",
              operation: "getRepositoryCloneUrls",
              cwd: input.cwd,
              repository: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.repository,
              ),
              detail: "Failed to get repository clone URLs.",
              cause: error,
            }),
        ),
      ),
    createRepository: (input) =>
      forgejo.createRepository(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "forgejo",
              operation: "createRepository",
              cwd: input.cwd,
              repository: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.repository,
              ),
              detail: "Failed to create repository.",
              cause: error,
            }),
        ),
      ),
    getDefaultBranch: (input) =>
      forgejo
        .getDefaultBranch({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "forgejo",
                operation: "getDefaultBranch",
                cwd: input.cwd,
                detail: "Failed to get default branch.",
                cause: error,
              }),
          ),
        ),
    checkoutChangeRequest: (input) =>
      forgejo
        .checkoutPullRequest({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
          reference: input.reference,
          ...(input.force !== undefined ? { force: input.force } : {}),
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "forgejo",
                operation: "checkoutChangeRequest",
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.reference,
                ),
                detail: "Failed to check out change request.",
                cause: error,
              }),
          ),
        ),
  });
});

export const layer = Layer.effect(SourceControlProvider.SourceControlProvider, make);

export const makeDiscovery = Effect.gen(function* () {
  const forgejo = yield* ForgejoApi.ForgejoApi;

  return {
    type: "api",
    kind: "forgejo",
    label: "Forgejo",
    installHint:
      "Set T3CODE_FORGEJO_TOKEN, and T3CODE_FORGEJO_HOST for a self-hosted instance (Codeberg is the default).",
    probeAuth: forgejo.probeAuth,
  } satisfies SourceControlApiDiscoverySpec;
});
