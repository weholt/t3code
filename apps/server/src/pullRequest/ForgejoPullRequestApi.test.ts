import { afterEach, assert, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ForgejoApi from "../sourceControl/ForgejoApi.ts";
import * as ForgejoPullRequestApi from "./ForgejoPullRequestApi.ts";

const mockedRequest = vi.fn<ForgejoApi.ForgejoApi["Service"]["request"]>();

const layer = it.layer(
  ForgejoPullRequestApi.layer.pipe(
    Layer.provide(
      Layer.mock(ForgejoApi.ForgejoApi)({
        request: mockedRequest,
      }),
    ),
  ),
);

/** The shape `request` answers with: a body plus whether it had to be cut short. */
function response(body: string) {
  return { body, truncated: false };
}

/** Who opened the pull request, and two accounts that could review it. */
const octocat = { login: "octocat" };
const julius = { login: "julius" };
const hubot = { login: "hubot" };

function pullRequest(number: number, overrides: Record<string, unknown> = {}) {
  return {
    number,
    title: `Pull request ${number}`,
    state: "open",
    merged: false,
    mergeable: true,
    user: octocat,
    created_at: "2026-06-16T05:04:32+00:00",
    updated_at: "2026-06-16T05:04:33+00:00",
    head: { ref: "feat/page", sha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0" },
    base: { ref: "main", sha: "0000000000000000000000000000000000000000" },
    additions: 9,
    deletions: 2,
    changed_files: 1,
    html_url: `https://codeberg.org/acme/web/pulls/${number}`,
    ...overrides,
  };
}

/** One page of `/pulls`: a bare array of `count` rows numbered from `firstNumber`. */
function page(count: number, firstNumber: number, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, index) => pullRequest(firstNumber + index, overrides)),
  );
}

/** One pull request as `/pulls/{index}` answers with it. */
function pullRequestJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify(pullRequest(7, overrides));
}

/** The request the nth call made. */
function callAt(index: number) {
  const call = mockedRequest.mock.calls[index];
  assert.isDefined(call);
  return call[0];
}

/** One parameter of the nth request, read back out of its query string. */
function paramOfCall(index: number, name: string): string | null {
  const url = callAt(index).url;
  return new URLSearchParams(url.slice(url.indexOf("?") + 1)).get(name);
}

afterEach(() => {
  mockedRequest.mockReset();
});

layer("ForgejoPullRequestApi.layer", (it) => {
  it.effect("asks for the newest first, one row past the caller's page", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(page(3, 1))));
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

      const batch = yield* api.listPullRequests({
        repository: "acme/web",
        state: "open",
        limit: 20,
      });

      assert.strictEqual(batch.items.length, 3);
      assert.isFalse(batch.truncated);
      assert.strictEqual(batch.cursorAdvance, 3);
      const url = callAt(0).url;
      expect(url).toContain("/repos/acme/web/pulls?");
      assert.strictEqual(paramOfCall(0, "state"), "open");
      assert.strictEqual(paramOfCall(0, "sort"), "recentupdate");
      // One more than asked for, which is how a next page is told apart from a short one.
      assert.strictEqual(paramOfCall(0, "limit"), "21");
      assert.strictEqual(paramOfCall(0, "page"), "1");
    }),
  );

  it.effect("walks Forgejo's offset pages up to the caller's page", () =>
    Effect.gen(function* () {
      mockedRequest
        .mockReturnValueOnce(Effect.succeed(response(page(50, 1))))
        .mockReturnValueOnce(Effect.succeed(response(page(50, 51))));
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

      const batch = yield* api.listPullRequests({
        repository: "acme/web",
        state: "open",
        limit: 100,
      });

      assert.strictEqual(batch.items.length, 100);
      // Over 50 Forgejo clamps the limit, so the page is walked in fifties — and a last page
      // that is full cannot say whether more follow, so more is assumed.
      assert.isTrue(batch.truncated);
      assert.strictEqual(mockedRequest.mock.calls.length, 2);
      assert.strictEqual(paramOfCall(0, "limit"), "50");
      assert.strictEqual(paramOfCall(0, "page"), "1");
      assert.strictEqual(paramOfCall(1, "page"), "2");
    }),
  );

  it.effect("stops on a short page and says nothing more remains", () =>
    Effect.gen(function* () {
      mockedRequest
        .mockReturnValueOnce(Effect.succeed(response(page(50, 1))))
        .mockReturnValueOnce(Effect.succeed(response(page(10, 51))));
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

      const batch = yield* api.listPullRequests({
        repository: "acme/web",
        state: "open",
        limit: 100,
      });

      assert.strictEqual(batch.items.length, 60);
      assert.isFalse(batch.truncated);
      assert.strictEqual(mockedRequest.mock.calls.length, 2);
    }),
  );

  it.effect("carries on from the rows already consumed rather than from the top", () =>
    Effect.gen(function* () {
      // 60 consumed at 21 a page puts the boundary 18 rows into page 3, whose rows are 43..63.
      // This page is short by one, so Forgejo has run out after it.
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(page(20, 43))));
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

      const batch = yield* api.listPullRequests({
        repository: "acme/web",
        state: "open",
        limit: 20,
        cursor: { updatedBefore: "2026-07-02T00:00:00Z", delivered: 60 },
      });

      assert.strictEqual(paramOfCall(0, "page"), "3");
      assert.strictEqual(paramOfCall(0, "limit"), "21");
      // The first 18 rows of that page were already handed over, so only the rest are new.
      expect(batch.items.map((item) => item.number)).toEqual([61, 62]);
      assert.isFalse(batch.truncated);
      assert.strictEqual(batch.cursorAdvance, 2);
    }),
  );

  it.effect("searches the owner's issues and reads each hit as a pull request", () =>
    Effect.gen(function* () {
      mockedRequest
        .mockReturnValueOnce(
          Effect.succeed(
            response(
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify([
                { number: 7, repository: { full_name: "acme/web" } },
                // Another repository of the same owner, which the search cannot leave out.
                { number: 3, repository: { full_name: "acme/other" } },
              ]),
            ),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(response(pullRequestJson())));
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

      const batch = yield* api.listPullRequests({
        repository: "acme/web",
        state: "open",
        limit: 20,
        query: "page",
      });

      expect(callAt(0).url).toContain("/repos/issues/search?");
      assert.strictEqual(paramOfCall(0, "type"), "pulls");
      assert.strictEqual(paramOfCall(0, "q"), "page");
      assert.strictEqual(paramOfCall(0, "owner"), "acme");
      assert.strictEqual(paramOfCall(0, "state"), "open");
      assert.strictEqual(callAt(1).url, "/repos/acme/web/pulls/7");
      expect(batch.items.map((item) => item.number)).toEqual([7]);
      // Both hits were consumed, so the cursor moves past both.
      assert.strictEqual(batch.cursorAdvance, 2);
      assert.strictEqual(mockedRequest.mock.calls.length, 2);
    }),
  );

  it.effect("asks for no search at all when the reader typed only spaces", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(page(0, 1))));
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

      yield* api.listPullRequests({
        repository: "acme/web",
        state: "open",
        limit: 20,
        query: "   ",
      });

      expect(callAt(0).url).toContain("/repos/acme/web/pulls?");
    }),
  );

  it.effect("asks for closed pull requests on the merged tab and keeps only the merged ones", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(
        Effect.succeed(
          response(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              pullRequest(1, { state: "closed", merged: true }),
              pullRequest(2, { state: "closed", merged: false }),
            ]),
          ),
        ),
      );
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

      const batch = yield* api.listPullRequests({
        repository: "acme/web",
        state: "merged",
        limit: 20,
      });

      assert.strictEqual(paramOfCall(0, "state"), "closed");
      expect(batch.items.map((item) => [item.number, item.state])).toEqual([[1, "merged"]]);
      assert.strictEqual(batch.cursorAdvance, 2);
    }),
  );

  it.effect("keeps a merged pull request off the closed tab", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(
        Effect.succeed(
          response(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              pullRequest(1, { state: "closed", merged: true }),
              pullRequest(2, { state: "closed", merged: false }),
            ]),
          ),
        ),
      );
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

      const batch = yield* api.listPullRequests({
        repository: "acme/web",
        state: "closed",
        limit: 20,
      });

      assert.strictEqual(paramOfCall(0, "state"), "closed");
      expect(batch.items.map((item) => [item.number, item.state])).toEqual([[2, "closed"]]);
    }),
  );

  it.effect("asks for every state at once on the All tab", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(page(0, 1))));
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

      yield* api.listPullRequests({ repository: "acme/web", state: "all", limit: 20 });

      assert.strictEqual(paramOfCall(0, "state"), "all");
    }),
  );

  it.effect("refuses a repository that is not owner and name", () =>
    Effect.gen(function* () {
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

      const error = yield* Effect.flip(
        api.listPullRequests({ repository: "acme/team/web", state: "open", limit: 20 }),
      );

      assert.strictEqual(error._tag, "ForgejoRepositoryUnsupportedError");
      assert.strictEqual(mockedRequest.mock.calls.length, 0);
    }),
  );

  it.effect("returns the diff verbatim, because Forgejo already sends a patch", () =>
    Effect.gen(function* () {
      const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n";
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(patch)));
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

      const diff = yield* api.getPullRequestDiff({ repository: "acme/web", number: 7 });

      assert.strictEqual(diff.patch, patch);
      assert.isFalse(diff.truncated);
      expect(callAt(0)).toMatchObject({
        url: "/repos/acme/web/pulls/7.diff",
        // A diff of any size would otherwise be read into memory whole.
        maxBytes: 8 * 1024 * 1024,
      });
    }),
  );

  it.effect("reads a named commit's own patch", () =>
    Effect.gen(function* () {
      const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n";
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(patch)));
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

      const diff = yield* api.getPullRequestDiff({
        repository: "acme/web",
        number: 7,
        commit: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      });

      assert.strictEqual(diff.patch, patch);
      expect(callAt(0)).toMatchObject({
        url: "/repos/acme/web/git/commits/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0.diff",
        maxBytes: 8 * 1024 * 1024,
      });
    }),
  );

  it.effect("refuses a commit that is not a sha rather than reading it into a URL", () =>
    Effect.gen(function* () {
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

      const error = yield* Effect.flip(
        api.getPullRequestDiff({
          repository: "acme/web",
          number: 7,
          commit: "../../acme/other/diff/deadbeef",
        }),
      );

      assert.strictEqual(error._tag, "ForgejoDiffCommitError");
      assert.strictEqual(mockedRequest.mock.calls.length, 0);
    }),
  );

  it.effect("reads the line counts and the mergeability off the pull request itself", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValue(
        Effect.succeed(response(pullRequestJson({ mergeable: false }))),
      );
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

      const stat = yield* api.getDiffStat({ repository: "acme/web", number: 7 });
      const mergeability = yield* api.getMergeability({ repository: "acme/web", number: 7 });

      expect(stat).toEqual({ additions: 9, deletions: 2, changedFiles: 1 });
      assert.strictEqual(mergeability, "conflicting");
      expect(callAt(0).url).toBe("/repos/acme/web/pulls/7");
      expect(callAt(1).url).toBe("/repos/acme/web/pulls/7");
    }),
  );

  it.effect("returns the complete commit timeline oldest first across pages", () =>
    Effect.gen(function* () {
      const commit = (sha: string, message: string, date: string) => ({
        sha,
        commit: { message, author: { name: "Ada", date } },
      });
      // A full first page, then a short second one, which is how Forgejo says it has run out.
      const firstPage = [
        ...Array.from({ length: 48 }, (_, index) =>
          commit(`f${String(index).padStart(3, "0")}`, "filler", "2026-07-05T00:00:00Z"),
        ),
        commit("ddd", "fourth", "2026-07-04T00:00:00Z"),
        commit("ccc", "third", "2026-07-03T00:00:00Z"),
      ];
      mockedRequest
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        .mockReturnValueOnce(Effect.succeed(response(JSON.stringify(firstPage))))
        .mockReturnValueOnce(
          Effect.succeed(
            response(
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify([
                commit("bbb", "second", "2026-07-02T00:00:00Z"),
                commit("aaa", "first", "2026-07-01T00:00:00Z"),
              ]),
            ),
          ),
        );
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

      const commits = yield* api.listCommits({ repository: "acme/web", number: 7 });

      expect(commits.slice(0, 4).map((commit) => commit.oid)).toEqual(["aaa", "bbb", "ccc", "ddd"]);
      assert.strictEqual(commits.length, 52);
      expect(callAt(0).url).toContain("/repos/acme/web/pulls/7/commits?");
      assert.strictEqual(paramOfCall(0, "page"), "1");
      assert.strictEqual(paramOfCall(1, "page"), "2");
    }),
  );

  it.effect("reads the checks off the head commit's combined status", () =>
    Effect.gen(function* () {
      mockedRequest
        .mockReturnValueOnce(Effect.succeed(response(pullRequestJson())))
        .mockReturnValueOnce(
          Effect.succeed(
            response(
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify({
                state: "failure",
                statuses: [
                  { context: "Build", status: "success" },
                  { context: "Lint", status: "failure" },
                ],
              }),
            ),
          ),
        );
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

      const checks = yield* api.listChecks({ repository: "acme/web", number: 7 });

      expect(checks.map((check) => [check.name, check.status])).toEqual([
        ["Build", "success"],
        ["Lint", "failure"],
      ]);
      expect(callAt(0).url).toBe("/repos/acme/web/pulls/7");
      expect(callAt(1).url).toBe(
        "/repos/acme/web/commits/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0/status",
      );
    }),
  );

  it.effect("skips the pull request read when the caller already holds the head commit", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(JSON.stringify({ statuses: [] }))));
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

      const checks = yield* api.listChecks({
        repository: "acme/web",
        number: 7,
        headSha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      });

      expect(checks).toEqual([]);
      assert.strictEqual(mockedRequest.mock.calls.length, 1);
      expect(callAt(0).url).toContain("/commits/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0/status");
    }),
  );

  it.effect("merges with Forgejo's own name for the strategy", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValue(Effect.succeed(response("{}")));
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

      yield* api.runAction({
        repository: "acme/web",
        number: 7,
        action: "merge",
        mergeMethod: "squash",
      });

      expect(callAt(0)).toMatchObject({
        method: "POST",
        url: "/repos/acme/web/pulls/7/merge",
        body: '{"Do":"squash"}',
      });
    }),
  );

  it.effect("merges with a merge commit when no strategy was named", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValue(Effect.succeed(response("{}")));
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

      yield* api.runAction({ repository: "acme/web", number: 7, action: "merge" });

      expect(callAt(0)).toMatchObject({ body: '{"Do":"merge"}' });
    }),
  );

  it.effect("closes and reopens a pull request by rewriting its state", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValue(Effect.succeed(response("{}")));
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

      yield* api.runAction({ repository: "acme/web", number: 7, action: "close" });
      yield* api.runAction({ repository: "acme/web", number: 7, action: "reopen" });

      expect(callAt(0)).toMatchObject({
        method: "PATCH",
        url: "/repos/acme/web/pulls/7",
        body: '{"state":"closed"}',
      });
      expect(callAt(1)).toMatchObject({
        method: "PATCH",
        url: "/repos/acme/web/pulls/7",
        body: '{"state":"open"}',
      });
    }),
  );

  it.effect("refuses an action the provider never offers", () =>
    Effect.gen(function* () {
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

      const error = yield* Effect.flip(
        api.runAction({ repository: "acme/web", number: 7, action: "draft" }),
      );

      assert.strictEqual(error._tag, "ForgejoActionUnsupportedError");
      assert.strictEqual(mockedRequest.mock.calls.length, 0);
    }),
  );

  it.effect("posts a comment as a JSON document, so the body stays text", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValue(Effect.succeed(response("{}")));
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

      yield* api.comment({ repository: "acme/web", number: 7, body: "true" });

      expect(callAt(0)).toMatchObject({
        method: "POST",
        url: "/repos/acme/web/issues/7/comments",
        body: '{"body":"true"}',
      });
    }),
  );

  it.effect("rewrites a title alone, without touching anything else", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValue(Effect.succeed(response("{}")));
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

      yield* api.updateChangeRequest({ repository: "acme/web", number: 7, title: "A new title" });

      const call = callAt(0);
      expect(call.method).toBe("PATCH");
      expect(call.url).toBe("/repos/acme/web/pulls/7");
      // Forgejo's PATCH is a partial update, so a field left out of the body is left as it was.
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(call.body ?? "")).toEqual({ title: "A new title" });
    }),
  );

  it.effect("leaves out the half of the pull request it was not asked about", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValue(Effect.succeed(response("{}")));
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

      yield* api.updateChangeRequest({ repository: "acme/web", number: 7, body: "New body." });

      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(callAt(0).body ?? "")).toEqual({ body: "New body." });
    }),
  );

  it.effect("writes both fields when both were rewritten", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValue(Effect.succeed(response("{}")));
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

      yield* api.updateChangeRequest({
        repository: "acme/web",
        number: 7,
        title: "A new title",
        body: "New body.",
      });

      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(callAt(0).body ?? "")).toEqual({ title: "A new title", body: "New body." });
    }),
  );

  it.effect("rewrites a comment where it stands, whichever kind it is", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValue(Effect.succeed(response("{}")));
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

      yield* api.updateComment({
        repository: "acme/web",
        number: 7,
        commentId: "10",
        body: "Edited.",
      });

      expect(callAt(0)).toMatchObject({
        method: "PATCH",
        url: "/repos/acme/web/issues/comments/10",
        body: '{"body":"Edited."}',
      });
    }),
  );

  it.effect("fails the read when Forgejo answers with something unreadable", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        Effect.succeed(response(JSON.stringify({ message: "nope" }))),
      );
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

      const error = yield* Effect.flip(api.getPullRequest({ repository: "acme/web", number: 7 }));

      assert.strictEqual(error._tag, "ForgejoPullRequestReadError");
    }),
  );

  it.effect("states a failure once, without stacking one message inside another", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(
        Effect.fail(
          new ForgejoApi.ForgejoResponseError({
            operation: "request",
            status: 500,
            responseBodyLength: 0,
          }),
        ),
      );
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

      const error = yield* Effect.flip(api.getViewer());

      // The fact only; the provider adds the operation around it.
      assert.strictEqual(error.detail, "Forgejo returned HTTP 500.");
    }),
  );

  it.effect("passes a refused token and a rate limit through as the response they were", () =>
    Effect.gen(function* () {
      mockedRequest
        .mockReturnValueOnce(
          Effect.fail(
            new ForgejoApi.ForgejoResponseError({
              operation: "request",
              status: 401,
              responseBodyLength: 0,
            }),
          ),
        )
        .mockReturnValueOnce(
          Effect.fail(
            new ForgejoApi.ForgejoResponseError({
              operation: "request",
              status: 429,
              responseBodyLength: 0,
              retryAt: 1_000,
            }),
          ),
        );
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

      const unauthenticated = yield* Effect.flip(api.getViewer());
      const rateLimited = yield* Effect.flip(
        api.getPullRequest({ repository: "acme/web", number: 7 }),
      );

      // The provider maps these to its own reasons, so the status must survive untouched.
      expect(unauthenticated).toMatchObject({ _tag: "ForgejoResponseError", status: 401 });
      expect(rateLimited).toMatchObject({
        _tag: "ForgejoResponseError",
        status: 429,
        retryAt: 1_000,
      });
    }),
  );

  it.effect("fails when the credentials belong to no named account", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(JSON.stringify({}))));
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

      const error = yield* Effect.flip(api.getViewer());

      assert.strictEqual(error._tag, "ForgejoViewerUnavailableError");
      expect(callAt(0).url).toBe("/user");
    }),
  );

  it.effect("reads remarks, reviews and line comments, and threads the last by line", () =>
    Effect.gen(function* () {
      mockedRequest.mockImplementation((input) => {
        if (input.url.startsWith("/repos/acme/web/issues/7/comments")) {
          return Effect.succeed(
            response(
              JSON.stringify([
                {
                  id: 13,
                  body: "ship it",
                  user: octocat,
                  created_at: "2026-06-16T08:04:32+00:00",
                },
              ]),
            ),
          );
        }
        if (input.url.startsWith("/repos/acme/web/pulls/7/reviews/")) {
          return Effect.succeed(
            response(
              JSON.stringify([
                {
                  id: 10,
                  body: "rename this",
                  path: "src/a.ts",
                  position: 12,
                  original_position: 0,
                  user: octocat,
                  created_at: "2026-06-16T05:04:32+00:00",
                },
                {
                  id: 11,
                  body: "done",
                  path: "src/a.ts",
                  position: 12,
                  original_position: 0,
                  user: julius,
                  created_at: "2026-06-16T06:04:32+00:00",
                },
              ]),
            ),
          );
        }
        if (input.url.startsWith("/repos/acme/web/pulls/7/reviews")) {
          return Effect.succeed(
            response(
              JSON.stringify([
                {
                  id: 100,
                  state: "REQUEST_CHANGES",
                  body: "Two things.",
                  user: octocat,
                  submitted_at: "2026-06-16T05:04:33+00:00",
                  comments_count: 2,
                },
                // Nothing to read here, so no request is spent on its comments.
                {
                  id: 101,
                  state: "APPROVED",
                  body: "",
                  user: julius,
                  submitted_at: "2026-06-16T09:04:32+00:00",
                  comments_count: 0,
                },
              ]),
            ),
          );
        }
        return Effect.succeed(response("[]"));
      });
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

      const { comments, threads, truncated } = yield* api.listComments({
        repository: "acme/web",
        number: 7,
      });

      expect(comments.map((comment) => [comment.id, comment.kind])).toEqual([
        ["10", "review-comment"],
        ["100", "review"],
        ["11", "review-comment"],
        ["13", "issue-comment"],
        ["101", "review"],
      ]);
      assert.strictEqual(threads.length, 1);
      expect(threads[0]).toMatchObject({
        id: "10",
        path: "src/a.ts",
        line: 12,
        side: "right",
        isResolved: false,
      });
      expect(threads[0]?.comments.map((comment) => comment.id)).toEqual(["10", "11"]);
      assert.isFalse(truncated);
      const urls = mockedRequest.mock.calls.map((call) => call[0].url);
      expect(urls.filter((url) => url.includes("/reviews/"))).toEqual([
        "/repos/acme/web/pulls/7/reviews/100/comments",
      ]);
    }),
  );

  it.effect("stops the comment walk at its bound and says the conversation was cut short", () =>
    Effect.gen(function* () {
      // A Forgejo that always fills a page: the walk has to end itself.
      mockedRequest.mockImplementation((input) =>
        Effect.succeed(
          response(
            input.url.includes("/issues/7/comments")
              ? JSON.stringify(
                  Array.from({ length: 50 }, (_, index) => ({
                    id: index + 1,
                    body: "again",
                    created_at: "2026-06-16T05:04:32+00:00",
                  })),
                )
              : "[]",
          ),
        ),
      );
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

      const { truncated } = yield* api.listComments({ repository: "acme/web", number: 7 });

      const commentPages = mockedRequest.mock.calls.filter((call) =>
        call[0].url.includes("/issues/7/comments"),
      );
      assert.strictEqual(commentPages.length, 10);
      assert.isTrue(truncated);
    }),
  );

  it.effect("sends a review whole: verdict, summary and line comments in one request", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValue(Effect.succeed(response("{}")));
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

      yield* api.submitReview({
        repository: "acme/web",
        number: 7,
        verdict: "request-changes",
        body: "Two things.",
        comments: [
          { path: "src/a.ts", position: { kind: "deleted", oldLine: 12 }, body: "why remove?" },
          { path: "src/b.ts", position: { kind: "added", newLine: 3 }, body: "nice" },
          {
            path: "src/c.ts",
            position: { kind: "context", oldLine: 5, newLine: 6, side: "left" },
            body: "here",
          },
        ],
      });

      assert.strictEqual(mockedRequest.mock.calls.length, 1);
      expect(callAt(0)).toMatchObject({ method: "POST", url: "/repos/acme/web/pulls/7/reviews" });
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(callAt(0).body ?? "")).toEqual({
        event: "REQUEST_CHANGES",
        body: "Two things.",
        comments: [
          { path: "src/a.ts", body: "why remove?", old_position: 12 },
          { path: "src/b.ts", body: "nice", new_position: 3 },
          { path: "src/c.ts", body: "here", old_position: 5 },
        ],
      });
    }),
  );

  it.effect("replies to a thread with a line comment on the same line", () =>
    Effect.gen(function* () {
      mockedRequest.mockImplementation((input) => {
        if (input.method === "POST") return Effect.succeed(response("{}"));
        if (input.url.startsWith("/repos/acme/web/pulls/7/reviews/")) {
          return Effect.succeed(
            response(
              JSON.stringify([
                {
                  id: 10,
                  body: "rename this",
                  path: "src/a.ts",
                  position: 0,
                  original_position: 12,
                  created_at: "2026-06-16T05:04:32+00:00",
                },
              ]),
            ),
          );
        }
        if (input.url.startsWith("/repos/acme/web/pulls/7/reviews")) {
          return Effect.succeed(
            response(
              JSON.stringify([
                {
                  id: 100,
                  state: "COMMENT",
                  submitted_at: "2026-06-16T05:04:33Z",
                  comments_count: 1,
                },
              ]),
            ),
          );
        }
        return Effect.succeed(response("[]"));
      });
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

      yield* api.replyToComment({
        repository: "acme/web",
        number: 7,
        commentId: "10",
        body: "Fixed.",
      });

      const post = mockedRequest.mock.calls.map((call) => call[0]).find((c) => c.method === "POST");
      assert.isDefined(post);
      expect(post.url).toBe("/repos/acme/web/pulls/7/reviews");
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(post.body ?? "")).toEqual({
        event: "COMMENT",
        body: "",
        comments: [{ path: "src/a.ts", body: "Fixed.", old_position: 12 }],
      });
    }),
  );

  it.effect("answers a comment that opens no thread as a plain remark", () =>
    Effect.gen(function* () {
      mockedRequest.mockImplementation((input) =>
        Effect.succeed(response(input.method === "POST" ? "{}" : "[]")),
      );
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

      yield* api.replyToComment({
        repository: "acme/web",
        number: 7,
        commentId: "13",
        body: "Fixed.",
      });

      const post = mockedRequest.mock.calls.map((call) => call[0]).find((c) => c.method === "POST");
      assert.isDefined(post);
      expect(post).toMatchObject({
        url: "/repos/acme/web/issues/7/comments",
        body: '{"body":"Fixed."}',
      });
    }),
  );

  it.effect("reads the repository's own permissions for the credentials", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValue(
        Effect.succeed(
          response(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({ full_name: "acme/web", permissions: { push: false, pull: true } }),
          ),
        ),
      );
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

      assert.isFalse(yield* api.getRepositoryPermission({ repository: "acme/web" }));

      expect(callAt(0).url).toBe("/repos/acme/web");
    }),
  );

  it.effect("still fails the permission read on a refused token", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValue(
        Effect.fail(
          new ForgejoApi.ForgejoResponseError({
            operation: "request",
            status: 401,
            responseBodyLength: 0,
          }),
        ),
      );
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

      const error = yield* Effect.flip(api.getRepositoryPermission({ repository: "acme/web" }));

      assert.strictEqual(error._tag, "ForgejoResponseError");
    }),
  );

  it.effect("reads the collaborators and marks whoever is already a reviewer", () =>
    Effect.gen(function* () {
      mockedRequest
        .mockReturnValueOnce(
          Effect.succeed(response(pullRequestJson({ requested_reviewers: [julius] }))),
        )
        .mockReturnValueOnce(
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          Effect.succeed(response(JSON.stringify([octocat, julius, hubot]))),
        );
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

      const list = yield* api.listReviewerCandidates({ repository: "acme/web", number: 7 });

      expect(callAt(1).url).toBe("/repos/acme/web/collaborators?limit=50&page=1");
      // The author is dropped: Forgejo refuses to make them their own reviewer.
      expect(list.candidates.map((candidate) => [candidate.id, candidate.isRequested])).toEqual([
        ["julius", true],
        ["hubot", false],
      ]);
      assert.isFalse(list.truncated);
    }),
  );

  it.effect("asks for a review by posting the login, and takes it back by deleting it", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValue(Effect.succeed(response("{}")));
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

      yield* api.setReviewerRequest({
        repository: "acme/web",
        number: 7,
        reviewers: [{ id: "hubot" }],
        requested: true,
      });
      yield* api.setReviewerRequest({
        repository: "acme/web",
        number: 7,
        reviewers: [{ id: "hubot" }],
        requested: false,
      });

      expect(callAt(0)).toMatchObject({
        method: "POST",
        url: "/repos/acme/web/pulls/7/requested_reviewers",
        body: '{"reviewers":["hubot"]}',
      });
      expect(callAt(1)).toMatchObject({
        method: "DELETE",
        url: "/repos/acme/web/pulls/7/requested_reviewers",
        body: '{"reviewers":["hubot"]}',
      });
    }),
  );

  it.effect("reacts to the pull request itself, and takes the reaction back", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValue(Effect.succeed(response("{}")));
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

      yield* api.setReaction({
        repository: "acme/web",
        number: 7,
        content: "thumbs-up",
        active: true,
      });
      yield* api.setReaction({
        repository: "acme/web",
        number: 7,
        content: "thumbs-up",
        active: false,
      });

      // The contract's name becomes Forgejo's, which is GitHub's spelling.
      expect(callAt(0)).toMatchObject({
        method: "POST",
        url: "/repos/acme/web/issues/7/reactions",
        body: '{"content":"+1"}',
      });
      expect(callAt(1)).toMatchObject({
        method: "DELETE",
        url: "/repos/acme/web/issues/7/reactions",
        body: '{"content":"+1"}',
      });
    }),
  );

  it.effect("reacts to a comment by its id", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValue(Effect.succeed(response("{}")));
      const api = yield* ForgejoPullRequestApi.ForgejoPullRequestApi;

      yield* api.setReaction({
        repository: "acme/web",
        number: 7,
        commentId: "10",
        content: "hooray",
        active: true,
      });

      expect(callAt(0)).toMatchObject({
        method: "POST",
        url: "/repos/acme/web/issues/comments/10/reactions",
        body: '{"content":"hooray"}',
      });
    }),
  );
});
