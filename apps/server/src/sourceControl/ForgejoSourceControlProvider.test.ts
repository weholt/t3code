import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ForgejoApi from "./ForgejoApi.ts";
import * as ForgejoSourceControlProvider from "./ForgejoSourceControlProvider.ts";

function makeProvider(forgejo: Partial<ForgejoApi.ForgejoApi["Service"]>) {
  return ForgejoSourceControlProvider.make.pipe(
    Effect.provide(
      Layer.mock(ForgejoApi.ForgejoApi)({ configuredUser: Option.none(), ...forgejo }),
    ),
  );
}

it.effect("maps Forgejo PR summaries into provider-neutral change requests", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      getPullRequest: () =>
        Effect.succeed({
          number: 42,
          title: "Add Forgejo provider",
          url: "https://codeberg.org/pingdotgg/t3code/pulls/42",
          baseRefName: "main",
          headRefName: "feature/source-control",
          state: "open",
          updatedAt: Option.none(),
          isCrossRepository: true,
          headRepositoryNameWithOwner: "fork/t3code",
          headRepositoryOwnerLogin: "fork",
        }),
    });

    const changeRequest = yield* provider.getChangeRequest({
      cwd: "/repo",
      reference: "42",
    });

    assert.deepStrictEqual(changeRequest, {
      provider: "forgejo",
      number: 42,
      title: "Add Forgejo provider",
      url: "https://codeberg.org/pingdotgg/t3code/pulls/42",
      baseRefName: "main",
      headRefName: "feature/source-control",
      state: "open",
      updatedAt: Option.none(),
      isCrossRepository: true,
      headRepositoryNameWithOwner: "fork/t3code",
      headRepositoryOwnerLogin: "fork",
    });
  }),
);

it.effect("adds repository context while retaining Forgejo API causes", () =>
  Effect.gen(function* () {
    const upstreamCause = new Error("raw upstream failure");
    const cause = new ForgejoApi.ForgejoRequestError({
      operation: "getRepository",
      cause: upstreamCause,
    });
    const provider = yield* makeProvider({
      getRepositoryCloneUrls: () => Effect.fail(cause),
    });

    const error = yield* provider
      .getRepositoryCloneUrls({ cwd: "/repo", repository: "owner/repo" })
      .pipe(Effect.flip);

    assert.deepStrictEqual(
      {
        provider: error.provider,
        operation: error.operation,
        command: error.command,
        cwd: error.cwd,
        repository: error.repository,
        detail: error.detail,
      },
      {
        provider: "forgejo",
        operation: "getRepositoryCloneUrls",
        command: undefined,
        cwd: "/repo",
        repository: "owner/repo",
        detail: "Failed to get repository clone URLs.",
      },
    );
    assert.strictEqual(error.cause, cause);
    assert.equal(error.message.includes(upstreamCause.message), false);
  }),
);

it.effect("lists Forgejo PRs through provider-neutral input names", () =>
  Effect.gen(function* () {
    let listInput: Parameters<ForgejoApi.ForgejoApi["Service"]["listPullRequests"]>[0] | null =
      null;
    const provider = yield* makeProvider({
      listPullRequests: (input) => {
        listInput = input;
        return Effect.succeed([]);
      },
    });

    yield* provider.listChangeRequests({
      cwd: "/repo",
      headSelector: "feature/provider",
      state: "all",
      limit: 10,
    });

    assert.deepStrictEqual(listInput, {
      cwd: "/repo",
      headSelector: "feature/provider",
      state: "all",
      limit: 10,
    });
  }),
);

it.effect("creates Forgejo PRs through provider-neutral input names", () =>
  Effect.gen(function* () {
    let createInput: Parameters<ForgejoApi.ForgejoApi["Service"]["createPullRequest"]>[0] | null =
      null;
    const provider = yield* makeProvider({
      createPullRequest: (input) => {
        createInput = input;
        return Effect.void;
      },
    });

    yield* provider.createChangeRequest({
      cwd: "/repo",
      baseRefName: "main",
      headSelector: "owner:feature/provider",
      title: "Provider PR",
      bodyFile: "/tmp/body.md",
    });

    assert.deepStrictEqual(createInput, {
      cwd: "/repo",
      baseBranch: "main",
      headSelector: "owner:feature/provider",
      source: {
        owner: "owner",
        refName: "feature/provider",
      },
      title: "Provider PR",
      bodyFile: "/tmp/body.md",
    });
  }),
);

it.effect("uses Forgejo API repository detection for default branch lookup", () =>
  Effect.gen(function* () {
    let cwdInput: string | null = null;
    const provider = yield* makeProvider({
      getDefaultBranch: (input) => {
        cwdInput = input.cwd;
        return Effect.succeed("main");
      },
    });

    const defaultBranch = yield* provider.getDefaultBranch({ cwd: "/repo" });

    assert.strictEqual(defaultBranch, "main");
    assert.strictEqual(cwdInput, "/repo");
  }),
);
