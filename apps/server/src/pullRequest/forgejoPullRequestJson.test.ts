import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import {
  buildReviewThreads,
  decodeCollaboratorsJson,
  decodeCommentsJson,
  decodeCommitsJson,
  decodeDiffstatJson,
  decodePullRequestJson,
  decodePullRequestPageJson,
  decodeReactionsJson,
  decodeRepositoryPermissionJson,
  decodeReviewCommentsJson,
  decodeReviewsJson,
  decodeSearchJson,
  decodeStatusesJson,
  decodeViewerJson,
  forgejoReactionName,
} from "./forgejoPullRequestJson.ts";

/** Shaped after a real codeberg.org pull request, trimmed to the fields that are read. */
function pullRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 4242,
    number: 42,
    title: "Add Forgejo provider",
    body: "# Add Forgejo provider",
    state: "open",
    merged: false,
    draft: false,
    mergeable: true,
    created_at: "2026-06-16T07:04:32+02:00",
    updated_at: "2026-06-16T07:04:33+02:00",
    merged_at: null,
    closed_at: null,
    user: { login: "octocat", full_name: "Octo Cat", avatar_url: "https://codeberg.org/a.png" },
    head: { ref: "feature/source-control", sha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0" },
    base: { ref: "main", sha: "0000000000000000000000000000000000000000" },
    requested_reviewers: [{ login: "julius", full_name: "Julius" }],
    labels: [{ name: "enhancement", color: "84b6eb" }],
    additions: 41,
    deletions: 16,
    changed_files: 2,
    html_url: "https://codeberg.org/acme/web/pulls/42",
    ...overrides,
  };
}

/** Forgejo answers every list as a bare array. */
function list(values: ReadonlyArray<unknown>): string {
  return JSON.stringify(values);
}

function expectSuccess<A>(result: Result.Result<A, unknown>): A {
  expect(Result.isSuccess(result)).toBe(true);
  if (!Result.isSuccess(result)) throw new Error("expected a successful decode");
  return result.success;
}

describe("decodePullRequestPageJson", () => {
  it("reads a pull request as a change request", () => {
    const decoded = expectSuccess(decodePullRequestPageJson(list([pullRequest()])));

    expect(decoded.items).toHaveLength(1);
    expect(decoded.items[0]).toMatchObject({
      number: 42,
      title: "Add Forgejo provider",
      url: "https://codeberg.org/acme/web/pulls/42",
      author: { login: "octocat", name: "Octo Cat", avatarUrl: "https://codeberg.org/a.png" },
      headBranch: "feature/source-control",
      baseBranch: "main",
      headSha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      state: "open",
      isDraft: false,
      mergeability: "mergeable",
      additions: 41,
      deletions: 16,
      changedFiles: 2,
      reviewRequestLogins: ["julius"],
      labels: [{ name: "enhancement", color: "84b6eb" }],
    });
    expect(decoded.rawCount).toBe(1);
    expect(decoded.rawIndexes).toEqual([0]);
  });

  it("normalizes Forgejo's offset timestamps, which the page sorts against other hosts", () => {
    const decoded = expectSuccess(decodePullRequestPageJson(list([pullRequest()])));

    expect(decoded.items[0]).toMatchObject({
      createdAt: "2026-06-16T05:04:32.000Z",
      updatedAt: "2026-06-16T05:04:33.000Z",
    });
  });

  it.each([
    [{ state: "closed", merged: true }, "merged"],
    [{ state: "closed", merged: false }, "closed"],
    [{ state: "open", merged: false }, "open"],
    [{ state: "something new" }, "open"],
  ])("reads %o as %s", (overrides, expected) => {
    const decoded = expectSuccess(decodePullRequestPageJson(list([pullRequest(overrides)])));

    expect(decoded.items[0]?.state).toBe(expected);
  });

  it.each([
    [true, "mergeable"],
    [false, "conflicting"],
    [null, "unknown"],
  ])("reads mergeable %s as %s", (mergeable, expected) => {
    const decoded = expectSuccess(decodePullRequestPageJson(list([pullRequest({ mergeable })])));

    expect(decoded.items[0]?.mergeability).toBe(expected);
  });

  it("skips a malformed row rather than failing the page, and says where the rest sat", () => {
    const decoded = expectSuccess(
      decodePullRequestPageJson(list([{ number: "not a number" }, pullRequest()])),
    );

    expect(decoded.items).toHaveLength(1);
    expect(decoded.rawCount).toBe(2);
    expect(decoded.rawIndexes).toEqual([1]);
  });

  it("fails when Forgejo did not answer with a list", () => {
    expect(Result.isFailure(decodePullRequestPageJson(JSON.stringify({ message: "nope" })))).toBe(
      true,
    );
  });
});

describe("decodePullRequestJson", () => {
  it("reads requested reviewers as review requests, addressed by login", () => {
    const decoded = expectSuccess(decodePullRequestJson(JSON.stringify(pullRequest())));

    expect(decoded.reviewRequestLogins).toEqual(["julius"]);
    expect(decoded.reviewers).toEqual([{ login: "julius", name: "Julius", avatarUrl: null }]);
    expect(decoded.reviewerIds).toEqual(["julius"]);
  });

  it("reads the merged and closed instants", () => {
    const decoded = expectSuccess(
      decodePullRequestJson(
        JSON.stringify(
          pullRequest({
            state: "closed",
            merged: true,
            merged_at: "2026-06-17T09:00:00+00:00",
            closed_at: "2026-06-17T09:00:00+00:00",
          }),
        ),
      ),
    );

    expect(decoded).toMatchObject({
      state: "merged",
      mergedAt: "2026-06-17T09:00:00.000Z",
      closedAt: "2026-06-17T09:00:00.000Z",
    });
  });

  it("reads a body of nothing where Forgejo sent null", () => {
    const decoded = expectSuccess(
      decodePullRequestJson(JSON.stringify(pullRequest({ body: null, labels: null }))),
    );

    expect(decoded.body).toBe("");
    expect(decoded.labels).toEqual([]);
  });
});

describe("decodeViewerJson", () => {
  it("reads the signed-in login", () => {
    const decoded = decodeViewerJson(JSON.stringify({ login: "octocat", full_name: "Octo Cat" }));

    expect(expectSuccess(decoded)).toBe("octocat");
  });

  it("falls back to the full name", () => {
    const decoded = decodeViewerJson(JSON.stringify({ full_name: "Release Bot" }));

    expect(expectSuccess(decoded)).toBe("Release Bot");
  });

  it("returns nothing when the account has neither", () => {
    expect(expectSuccess(decodeViewerJson(JSON.stringify({})))).toBeNull();
  });
});

describe("decodeCommentsJson", () => {
  it("keeps a posted comment and drops an empty one", () => {
    const decoded = expectSuccess(
      decodeCommentsJson(
        list([
          {
            id: 797230941,
            body: "The issue is ready for review.",
            user: { login: "release-bot" },
            created_at: "2026-05-15T01:58:38+00:00",
            html_url: "https://codeberg.org/acme/web/pulls/42#issuecomment-797230941",
          },
          { id: 4, body: "   ", created_at: "2026-05-15T02:00:00+00:00" },
        ]),
      ),
    );

    expect(decoded.items).toHaveLength(1);
    expect(decoded.rawCount).toBe(2);
    expect(decoded.items[0]).toMatchObject({
      id: "797230941",
      kind: "issue-comment",
      author: { login: "release-bot" },
      createdAt: "2026-05-15T01:58:38.000Z",
      url: "https://codeberg.org/acme/web/pulls/42#issuecomment-797230941",
    });
  });
});

describe("decodeReactionsJson", () => {
  it("groups reactions by content, marks the viewer's own and names everyone else", () => {
    const reactions = expectSuccess(
      decodeReactionsJson(
        list([
          { content: "+1", user: { login: "julius" }, created_at: "2026-05-15T01:58:38+00:00" },
          { content: "+1", user: { login: "octocat" }, created_at: "2026-05-15T01:59:38+00:00" },
          { content: "heart", user: { login: "julius" }, created_at: "2026-05-15T02:00:00+00:00" },
        ]),
        "octocat",
      ),
    );

    // `octocat` is the viewer, so the group they are in reads back as reacted, but their own
    // login is left out of `actors` — the page names them "You" instead — while `count` still
    // counts them.
    expect(reactions).toEqual([
      { content: "thumbs-up", count: 2, actors: ["julius"], viewerHasReacted: true },
      { content: "heart", count: 1, actors: ["julius"], viewerHasReacted: false },
    ]);
  });

  it("matches the viewer's login case-insensitively, and marks nothing without a viewer", () => {
    const rows = list([{ content: "-1", user: { login: "Octocat" } }]);

    expect(expectSuccess(decodeReactionsJson(rows, "octocat"))).toEqual([
      { content: "thumbs-down", count: 1, actors: [], viewerHasReacted: true },
    ]);
    // A token refused at `/user` names no viewer, so the same reaction is someone else's.
    expect(expectSuccess(decodeReactionsJson(rows, null))).toEqual([
      { content: "thumbs-down", count: 1, actors: ["Octocat"], viewerHasReacted: false },
    ]);
  });

  it("drops a reaction outside the eight, one without a name, and a malformed row", () => {
    const reactions = expectSuccess(
      decodeReactionsJson(
        list([
          { content: "partyparrot", user: { login: "julius" } },
          { content: "rocket", user: null },
          "not a reaction",
          { content: "rocket", user: { login: "julius" } },
        ]),
        null,
      ),
    );

    expect(reactions).toEqual([
      { content: "rocket", count: 1, actors: ["julius"], viewerHasReacted: false },
    ]);
  });

  it("fails when Forgejo did not answer with a list", () => {
    expect(Result.isFailure(decodeReactionsJson("{}", null))).toBe(true);
  });

  it("spells the contract's names the way Forgejo does, and reads them back the same way", () => {
    expect(forgejoReactionName("thumbs-up")).toBe("+1");
    expect(forgejoReactionName("thumbs-down")).toBe("-1");
    expect(forgejoReactionName("hooray")).toBe("hooray");
    expect(
      expectSuccess(decodeReactionsJson(list([{ content: "+1", user: { login: "j" } }]), null)),
    ).toMatchObject([{ content: "thumbs-up" }]);
  });
});

describe("decodeReviewsJson", () => {
  it("reads an approval and a request for changes as verdicts the page recognises", () => {
    const decoded = expectSuccess(
      decodeReviewsJson(
        list([
          {
            id: 1,
            state: "APPROVED",
            body: "",
            user: { login: "julius" },
            submitted_at: "2026-06-17T09:00:00+00:00",
            comments_count: 0,
          },
          {
            id: 2,
            state: "REQUEST_CHANGES",
            body: "Two things.",
            user: { login: "sam" },
            submitted_at: "2026-06-17T10:00:00+00:00",
            comments_count: 2,
          },
        ]),
      ),
    );

    expect(decoded.items.map((review) => review.comment)).toEqual([
      expect.objectContaining({
        id: "1",
        kind: "review",
        author: expect.objectContaining({ login: "julius" }),
        reviewState: "APPROVED",
        createdAt: "2026-06-17T09:00:00.000Z",
      }),
      expect.objectContaining({ id: "2", reviewState: "CHANGES_REQUESTED", body: "Two things." }),
    ]);
    expect(decoded.items.map((review) => review.hasComments)).toEqual([false, true]);
  });

  it("drops a pending review and a bodiless comment review, but keeps its line comments", () => {
    const decoded = expectSuccess(
      decodeReviewsJson(
        list([
          { id: 1, state: "PENDING", body: "wip", submitted_at: null, comments_count: 1 },
          {
            id: 2,
            state: "COMMENT",
            body: "",
            user: { login: "sam" },
            submitted_at: "2026-06-17T10:00:00+00:00",
            comments_count: 1,
          },
        ]),
      ),
    );

    expect(decoded.items).toHaveLength(1);
    expect(decoded.items[0]).toMatchObject({ id: 2, comment: null, hasComments: true });
  });
});

describe("decodeReviewCommentsJson and buildReviewThreads", () => {
  it("reads a comment pinned to a file as a review comment", () => {
    const decoded = expectSuccess(
      decodeReviewCommentsJson(
        list([
          {
            id: 5,
            body: "Rename this.",
            path: "src/app.ts",
            position: 12,
            original_position: 0,
            created_at: "2026-05-15T02:00:00+00:00",
          },
        ]),
      ),
    );

    expect(decoded.comments[0]).toMatchObject({ kind: "review-comment", path: "src/app.ts" });
    expect(decoded.entries).toHaveLength(1);
  });

  it("groups comments on one line into a thread named after the oldest", () => {
    const decoded = expectSuccess(
      decodeReviewCommentsJson(
        list([
          {
            id: 11,
            body: "done",
            path: "src/a.ts",
            position: 12,
            original_position: 0,
            user: { login: "julius" },
            created_at: "2026-06-16T06:04:32+00:00",
          },
          {
            id: 10,
            body: "rename this",
            path: "src/a.ts",
            position: 12,
            original_position: 0,
            user: { login: "octocat" },
            created_at: "2026-06-16T05:04:32+00:00",
          },
          // Written against the removed side, so it is a thread of its own.
          {
            id: 12,
            body: "why remove?",
            path: "src/a.ts",
            position: 0,
            original_position: 12,
            user: { login: "octocat" },
            created_at: "2026-06-16T07:04:32+00:00",
            resolver: { login: "julius" },
          },
        ]),
      ),
    );

    const threads = buildReviewThreads(decoded.entries);

    expect(threads).toHaveLength(2);
    expect(threads[0]).toMatchObject({
      id: "10",
      path: "src/a.ts",
      line: 12,
      side: "right",
      isResolved: false,
      isOutdated: false,
    });
    expect(threads[0]?.comments.map((comment) => comment.id)).toEqual(["10", "11"]);
    expect(threads[1]).toMatchObject({ id: "12", line: 12, side: "left", isResolved: true });
  });
});

describe("decodeCommitsJson", () => {
  it("returns commits oldest first with only the subject line", () => {
    const decoded = expectSuccess(
      decodeCommitsJson(
        list([
          {
            sha: "bbb",
            commit: {
              message: "second\n\nbody text\n",
              author: { name: "Ada Lovelace", date: "2026-06-16T04:51:00+00:00" },
            },
            author: null,
          },
          {
            sha: "aaa",
            commit: {
              message: "first\n",
              author: { name: "Ada Lovelace", date: "2026-06-16T04:50:49+00:00" },
            },
            author: { login: "ada", full_name: "Ada Lovelace" },
          },
        ]),
      ),
    );

    expect(decoded.items.map((commit) => commit.oid)).toEqual(["aaa", "bbb"]);
    expect(decoded.items[0]?.authors).toEqual([
      { login: "ada", name: "Ada Lovelace", avatarUrl: null },
    ]);
    // No account behind the commit, so the name in the commit is the only handle it has.
    expect(decoded.items[1]?.authors).toEqual([
      { login: "Ada Lovelace", name: "Ada Lovelace", avatarUrl: null },
    ]);
    expect(decoded.items[1]?.messageHeadline).toBe("second");
    expect(decoded.rawCount).toBe(2);
  });

  it("skips commits whose sha is empty", () => {
    const decoded = expectSuccess(
      decodeCommitsJson(
        list([
          { sha: "   ", commit: { message: "invalid", author: { date: "2026-06-16T04:51:00Z" } } },
          { sha: "aaa", commit: { author: { date: "2026-06-16T04:50:49+00:00" } } },
        ]),
      ),
    );

    expect(decoded.items.map((commit) => commit.oid)).toEqual(["aaa"]);
  });
});

describe("decodeStatusesJson", () => {
  it("reads a commit status as a check", () => {
    const decoded = expectSuccess(
      decodeStatusesJson(
        JSON.stringify({
          state: "success",
          statuses: [
            {
              context: "ci/woodpecker/pr/build",
              status: "success",
              description: "",
              target_url: "https://ci.codeberg.org/repos/1/pipeline/8126",
            },
          ],
        }),
      ),
    );

    expect(decoded).toEqual([
      {
        name: "ci/woodpecker/pr/build",
        status: "success",
        description: null,
        url: "https://ci.codeberg.org/repos/1/pipeline/8126",
      },
    ]);
  });

  it.each([
    ["success", "success"],
    ["failure", "failure"],
    ["error", "failure"],
    ["pending", "pending"],
    ["warning", "neutral"],
    ["something new", "neutral"],
  ])("reads the %s status as %s", (status, expected) => {
    const decoded = expectSuccess(
      decodeStatusesJson(JSON.stringify({ statuses: [{ context: "Pipeline", status }] })),
    );

    expect(decoded[0]?.status).toBe(expected);
  });

  it("keeps the newest of two statuses under one context", () => {
    const decoded = expectSuccess(
      decodeStatusesJson(
        JSON.stringify({
          statuses: [
            { context: "build", status: "failure", updated_at: "2026-06-16T04:50:00Z" },
            { context: "build", status: "success", updated_at: "2026-06-16T04:55:00Z" },
          ],
        }),
      ),
    );

    expect(decoded.map((check) => [check.name, check.status])).toEqual([["build", "success"]]);
  });
});

describe("decodeDiffstatJson", () => {
  it("reads the counts off the pull request itself", () => {
    const decoded = expectSuccess(decodeDiffstatJson(JSON.stringify(pullRequest())));

    expect(decoded).toEqual({ additions: 41, deletions: 16, changedFiles: 2 });
  });
});

describe("decodeCollaboratorsJson", () => {
  it("reads a collaborator as a candidate addressed by login", () => {
    const decoded = expectSuccess(
      decodeCollaboratorsJson(
        list([
          { id: 1, login: "julius", full_name: "Julius", avatar_url: "https://codeberg.org/j.png" },
          { id: 2, login: "" },
        ]),
      ),
    );

    expect(decoded.items).toEqual([
      {
        id: "julius",
        login: "julius",
        name: "Julius",
        avatarUrl: "https://codeberg.org/j.png",
        kind: "user",
        isRequested: false,
      },
    ]);
    expect(decoded.rawCount).toBe(2);
  });
});

describe("decodeSearchJson", () => {
  it("reads a hit's number and the repository it lives in", () => {
    const decoded = expectSuccess(
      decodeSearchJson(
        list([
          { number: 42, repository: { full_name: "acme/web" } },
          { number: 7, repository: { full_name: "acme/other" } },
          { number: "bad" },
        ]),
      ),
    );

    expect(decoded.items).toEqual([
      { number: 42, repository: "acme/web" },
      { number: 7, repository: "acme/other" },
    ]);
    expect(decoded.rawIndexes).toEqual([0, 1]);
    expect(decoded.rawCount).toBe(3);
  });
});

describe("repository permission decoding", () => {
  const repository = (push: boolean | null) =>
    JSON.stringify({ full_name: "acme/web", permissions: { admin: false, push, pull: true } });

  it("counts push as write, and its absence as not", () => {
    expect(expectSuccess(decodeRepositoryPermissionJson(repository(true)))).toBe(true);
    expect(expectSuccess(decodeRepositoryPermissionJson(repository(false)))).toBe(false);
  });

  it("grants write where Forgejo named no permission at all", () => {
    // Left out is Forgejo declining to say, which is an unknown standing rather than a refusal —
    // and an unknown one is granted.
    expect(expectSuccess(decodeRepositoryPermissionJson(repository(null)))).toBe(true);
    expect(
      expectSuccess(decodeRepositoryPermissionJson(JSON.stringify({ full_name: "acme/web" }))),
    ).toBe(true);
  });
});
