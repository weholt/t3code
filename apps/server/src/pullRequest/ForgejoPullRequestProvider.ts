import * as Effect from "effect/Effect";
import type { PullRequestCapabilities, PullRequestViewerPermissions } from "@t3tools/contracts";

import * as ForgejoPullRequestApi from "./ForgejoPullRequestApi.ts";
import {
  PullRequestProviderError,
  type PullRequestProviderFailure,
  type ProviderChangeRequest,
  type ProviderChangeRequestActivity,
  type ProviderChangeRequestDetail,
  type PullRequestProviderApi,
} from "./PullRequestProvider.ts";
import type { ForgejoPullRequest } from "./forgejoPullRequestJson.ts";

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  // Forgejo has nothing documented that moves a pull request in or out of draft, so neither is
  // offered rather than failing when pressed.
  actions: ["merge", "close", "reopen"],
  mergeMethods: ["merge", "squash", "rebase"],
  search: true,
  reactions: true,
  review: {
    inlineComment: true,
    reply: true,
    // Forgejo keeps no resolved state on a review conversation.
    resolve: false,
    verdicts: ["comment", "approve", "request-changes"],
  },
  reviewers: { request: true, listCandidates: true },
  edit: { changeRequest: true, comment: true },
};

/**
 * What the configured account may do here, from the one thing Forgejo states per viewer: the
 * repository permission. Merging, closing and reopening need push access, so that is what narrows.
 *
 * Commenting and reviewing are not narrowed: read access is enough to say something, to approve
 * and to ask for changes. Asking for a review is left open too, because Forgejo takes a reviewer
 * set from the author of a pull request as well as from whoever can write, and says nothing here
 * about which of the two this account is.
 */
export function forgejoViewerPermissions(input: {
  readonly canWrite: boolean;
}): PullRequestViewerPermissions {
  return {
    actions: input.canWrite ? CAPABILITIES.actions : [],
    comment: true,
    resolve: false,
    verdicts: CAPABILITIES.review.verdicts,
    requestReviewers: true,
  };
}

/** The failures that mean the credentials are the problem, rather than one request. */
export function forgejoProviderFailure(
  error: ForgejoPullRequestApi.ForgejoPullRequestApiError,
): PullRequestProviderFailure {
  // Forgejo is read over HTTP with credentials from the environment, so there is no tool to be
  // missing: unusable always means the credentials are absent or refused.
  if (error._tag === "ForgejoResponseError" && error.status === 401) {
    return { reason: "unauthenticated" };
  }
  if (error._tag === "ForgejoResponseError" && error.status === 429) {
    return {
      reason: "rate-limited",
      ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
    };
  }
  return { reason: "failed" };
}

function toChangeRequest(pullRequest: ForgejoPullRequest): ProviderChangeRequest {
  return {
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.url,
    author: pullRequest.author,
    headBranch: pullRequest.headBranch,
    baseBranch: pullRequest.baseBranch,
    state: pullRequest.state,
    isDraft: pullRequest.isDraft,
    mergeability: pullRequest.mergeability,
    additions: pullRequest.additions,
    deletions: pullRequest.deletions,
    createdAt: pullRequest.createdAt,
    updatedAt: pullRequest.updatedAt,
    reviewRequestLogins: pullRequest.reviewRequestLogins,
    labels: pullRequest.labels,
  };
}

export const make = Effect.gen(function* () {
  const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

  const fail = (operation: string) => (error: ForgejoPullRequestApi.ForgejoPullRequestApiError) =>
    new PullRequestProviderError({
      provider: "forgejo",
      operation,
      ...forgejoProviderFailure(error),
      // Every Forgejo failure states its own fact; this names the operation around it, so the
      // two do not stack into "failed in x: failed in y: ...".
      detail: error.detail,
      cause: error,
    });

  const provider: PullRequestProviderApi = {
    kind: "forgejo",
    capabilities: CAPABILITIES,

    // Forgejo credentials come from the server's environment rather than a checkout, so the
    // account is the same whichever workspace asks.
    getViewer: () => api.getViewer().pipe(Effect.mapError(fail("getViewer"))),

    listChangeRequests: (input) =>
      api
        .listPullRequests({
          repository: input.repository,
          state: input.state,
          limit: input.limit,
          query: input.query,
          cursor: input.cursor,
        })
        .pipe(
          Effect.mapError(fail("listChangeRequests")),
          // Forgejo is asked for its pull requests by update, newest first, whether or not it is
          // being carried on from — so every page it answers is one a cursor can continue.
          Effect.map((batch) => ({
            items: batch.items.map(toChangeRequest),
            truncated: batch.truncated,
            cursorAdvance: batch.cursorAdvance,
            continues: true,
          })),
        ),

    getChangeRequest: (input) => {
      const target = { repository: input.repository, number: input.number };
      return api.getPullRequest(target).pipe(
        Effect.flatMap((pullRequest) =>
          Effect.all(
            [
              // The pull request already names its head commit, which saves the checks a re-read.
              api
                .listChecks({ ...target, headSha: pullRequest.headSha })
                .pipe(Effect.orElseSucceed(() => [])),
              // A permission that could not be read is an unknown one, which is granted: a hidden
              // Merge leaves someone entitled to it with no way through, and one Forgejo refuses
              // at least says why.
              api.getRepositoryPermission(target).pipe(Effect.orElseSucceed(() => true)),
            ],
            { concurrency: 2 },
          ).pipe(
            Effect.map(
              ([checks, canWrite]): ProviderChangeRequestDetail => ({
                ...toChangeRequest(pullRequest),
                changedFiles: pullRequest.changedFiles,
                body: pullRequest.body,
                mergedAt: pullRequest.mergedAt,
                closedAt: pullRequest.closedAt,
                reviewers: pullRequest.reviewers,
                checks,
                // The repository's allowed strategies are not read, so the ones Forgejo supports
                // are all offered and a strategy the repository forbids fails on merge.
                mergeCapabilities: { merge: true, squash: true, rebase: true },
                viewerPermissions: forgejoViewerPermissions({ canWrite }),
              }),
            ),
          ),
        ),
        Effect.mapError(fail("getChangeRequest")),
      );
    },

    getChangeRequestActivity: (input) => {
      const target = { repository: input.repository, number: input.number };
      return Effect.all(
        [
          // Review verdicts are already folded into the conversation with the remarks and the
          // line comments, so nothing on the pull request itself is needed here.
          api
            .listComments(target)
            .pipe(Effect.orElseSucceed(() => ({ comments: [], threads: [], truncated: true }))),
          api.listCommits(target).pipe(Effect.orElseSucceed(() => [])),
        ],
        { concurrency: 2 },
      ).pipe(
        Effect.mapError(fail("getChangeRequestActivity")),
        Effect.map(
          ([comments, commits]): ProviderChangeRequestActivity => ({
            comments: comments.comments,
            commentCount: comments.comments.length,
            commentsTruncated: comments.truncated,
            reviewThreads: comments.threads,
            commits,
          }),
        ),
      );
    },

    getViewerPermissions: (input) =>
      api.getRepositoryPermission({ repository: input.repository }).pipe(
        Effect.mapError(fail("getViewerPermissions")),
        Effect.map((canWrite) => forgejoViewerPermissions({ canWrite })),
      ),

    // `.diff` answers with the whole patch and pages nothing, so the first slice is the last.
    getDiff: (input) =>
      api
        .getPullRequestDiff({
          repository: input.repository,
          number: input.number,
          ...(input.commit === undefined ? {} : { commit: input.commit }),
        })
        .pipe(
          Effect.mapError(fail("getDiff")),
          Effect.map((diff) => ({ ...diff, nextCursor: null })),
        ),

    // Users only: the collaborators are read, and Forgejo's team reviewers are not offered.
    listReviewerCandidates: (input) =>
      api
        .listReviewerCandidates({ repository: input.repository, number: input.number })
        .pipe(Effect.mapError(fail("listReviewerCandidates"))),

    setReviewerRequest: (input) =>
      api
        .setReviewerRequest({
          repository: input.repository,
          number: input.number,
          reviewers: input.reviewers,
          requested: input.requested,
        })
        .pipe(Effect.mapError(fail("setReviewerRequest"))),

    runAction: (input) =>
      api
        .runAction({
          repository: input.repository,
          number: input.number,
          action: input.action,
          ...(input.mergeMethod === undefined ? {} : { mergeMethod: input.mergeMethod }),
        })
        .pipe(Effect.mapError(fail("runAction"))),

    updateChangeRequest: (input) =>
      api
        .updateChangeRequest({
          repository: input.repository,
          number: input.number,
          title: input.title,
          body: input.body,
        })
        .pipe(Effect.mapError(fail("updateChangeRequest"))),

    comment: (input) =>
      api
        .comment({ repository: input.repository, number: input.number, body: input.body })
        .pipe(Effect.mapError(fail("comment"))),

    updateComment: (input) =>
      api
        .updateComment({
          repository: input.repository,
          number: input.number,
          commentId: input.commentId,
          body: input.body,
        })
        .pipe(Effect.mapError(fail("updateComment"))),

    submitReview: (input) =>
      api
        .submitReview({
          repository: input.repository,
          number: input.number,
          verdict: input.verdict,
          body: input.body,
          comments: input.comments,
        })
        .pipe(Effect.mapError(fail("submitReview"))),

    replyToThread: (input) =>
      api
        .replyToComment({
          repository: input.repository,
          number: input.number,
          commentId: input.threadId,
          body: input.body,
        })
        .pipe(Effect.mapError(fail("replyToThread"))),

    setReaction: (input) =>
      api
        .setReaction({
          repository: input.repository,
          number: input.number,
          ...(input.subjectId === undefined ? {} : { commentId: input.subjectId }),
          content: input.content,
          active: input.reacted,
        })
        .pipe(Effect.mapError(fail("setReaction"))),

    // Never called: `capabilities.review.resolve` is false, and the service refuses without it.
    setThreadResolution: () =>
      Effect.fail(
        new PullRequestProviderError({
          provider: "forgejo",
          operation: "setThreadResolution",
          reason: "failed",
          detail: "Forgejo does not support resolving review threads.",
        }),
      ),
  };

  return provider;
});
