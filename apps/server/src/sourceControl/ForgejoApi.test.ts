import { assert, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import { GitCommandError } from "@t3tools/contracts";
import * as ForgejoApi from "./ForgejoApi.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import type * as VcsDriver from "../vcs/VcsDriver.ts";

const forgejoPullRequest = {
  number: 42,
  title: "Add Forgejo provider",
  state: "open",
  merged: false,
  updated_at: "2026-01-02T00:00:00.000Z",
  html_url: "https://codeberg.org/pingdotgg/t3code/pulls/42",
  head: {
    ref: "feature/source-control",
    repo: { full_name: "octocat/t3code", owner: { login: "octocat" } },
  },
  base: {
    ref: "main",
    repo: { full_name: "pingdotgg/t3code", owner: { login: "pingdotgg" } },
  },
};

const repositoryJson = {
  full_name: "pingdotgg/t3code",
  html_url: "https://codeberg.org/pingdotgg/t3code",
  clone_url: "https://codeberg.org/pingdotgg/t3code.git",
  ssh_url: "git@codeberg.org:pingdotgg/t3code.git",
  default_branch: "main",
  owner: { login: "pingdotgg" },
};

function decodeBody(request: HttpClientRequest.HttpClientRequest): unknown {
  const rawBody = (request.body as { readonly body?: Uint8Array }).body;
  assert.ok(rawBody);
  return JSON.parse(new TextDecoder().decode(rawBody));
}

function makeLayer(input: {
  readonly response: (request: HttpClientRequest.HttpClientRequest) => Response;
  readonly requestFailure?: (
    request: HttpClientRequest.HttpClientRequest,
  ) => HttpClientError.HttpClientError;
  readonly git?: Partial<GitVcsDriver.GitVcsDriver["Service"]>;
  /** The configured instance; a scheme or trailing slash is tolerated. */
  readonly host?: string;
  /** `T3CODE_FORGEJO_USER`, for a token that cannot read `/user`. */
  readonly user?: string;
}) {
  const execute = vi.fn((request: HttpClientRequest.HttpClientRequest) =>
    input.requestFailure
      ? Effect.fail(input.requestFailure(request))
      : Effect.succeed(HttpClientResponse.fromWeb(request, input.response(request))),
  );
  const gitMock = {
    readConfigValue: vi.fn<GitVcsDriver.GitVcsDriver["Service"]["readConfigValue"]>(() =>
      Effect.succeed<string | null>("git@codeberg.org:pingdotgg/t3code.git"),
    ),
    resolvePrimaryRemoteName: vi.fn<
      GitVcsDriver.GitVcsDriver["Service"]["resolvePrimaryRemoteName"]
    >(() => Effect.succeed("origin")),
    ensureRemote: vi.fn<GitVcsDriver.GitVcsDriver["Service"]["ensureRemote"]>(() =>
      Effect.succeed("octocat"),
    ),
    fetchRemoteBranch: vi.fn<GitVcsDriver.GitVcsDriver["Service"]["fetchRemoteBranch"]>(
      () => Effect.void,
    ),
    fetchRemoteTrackingBranch: vi.fn<
      GitVcsDriver.GitVcsDriver["Service"]["fetchRemoteTrackingBranch"]
    >(() => Effect.void),
    setBranchUpstream: vi.fn<GitVcsDriver.GitVcsDriver["Service"]["setBranchUpstream"]>(
      () => Effect.void,
    ),
    switchRef: vi.fn<GitVcsDriver.GitVcsDriver["Service"]["switchRef"]>((request) =>
      Effect.succeed({ refName: request.refName }),
    ),
    listLocalBranchNames: vi.fn<GitVcsDriver.GitVcsDriver["Service"]["listLocalBranchNames"]>(() =>
      Effect.succeed([]),
    ),
  };
  const git = {
    ...gitMock,
    ...input.git,
  } satisfies Partial<GitVcsDriver.GitVcsDriver["Service"]>;

  const driver = {
    listRemotes: () =>
      Effect.succeed({
        remotes: [
          {
            name: "origin",
            url: "git@codeberg.org:pingdotgg/t3code.git",
            pushUrl: Option.none(),
            isPrimary: true,
          },
        ],
        freshness: {
          source: "live-local" as const,
          observedAt: DateTime.makeUnsafe("1970-01-01T00:00:00.000Z"),
          expiresAt: Option.none(),
        },
      }),
  } satisfies Partial<VcsDriver.VcsDriver["Service"]>;

  const layer = ForgejoApi.layer.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => execute(request)),
      ),
    ),
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        resolve: () =>
          Effect.succeed({
            kind: "git",
            repository: {
              kind: "git",
              rootPath: "/repo",
              metadataPath: null,
              freshness: {
                source: "live-local" as const,
                observedAt: DateTime.makeUnsafe("1970-01-01T00:00:00.000Z"),
                expiresAt: Option.none(),
              },
            },
            driver: driver as unknown as VcsDriver.VcsDriver["Service"],
          }),
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)(git)),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: {
            T3CODE_FORGEJO_HOST: input.host ?? "git.test.local",
            T3CODE_FORGEJO_TOKEN: "abc",
            ...(input.user === undefined ? {} : { T3CODE_FORGEJO_USER: input.user }),
          },
        }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

  return { execute, git: gitMock, layer };
}

it.effect("parses pull request responses from the Forgejo REST API", () => {
  const { execute, layer } = makeLayer({
    response: () =>
      Response.json({
        ...forgejoPullRequest,
      }),
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    const result = yield* forgejo.getPullRequest({
      cwd: "/repo",
      reference: "#42",
    });

    assert.deepStrictEqual(result, {
      number: 42,
      title: "Add Forgejo provider",
      url: "https://codeberg.org/pingdotgg/t3code/pulls/42",
      baseRefName: "main",
      headRefName: "feature/source-control",
      state: "open",
      updatedAt: Option.some(DateTime.makeUnsafe("2026-01-02T00:00:00.000Z")),
      isCrossRepository: true,
      headRepositoryNameWithOwner: "octocat/t3code",
      headRepositoryOwnerLogin: "octocat",
    });
    const request = execute.mock.calls[0]?.[0];
    assert.strictEqual(
      request?.url,
      "https://git.test.local/api/v1/repos/pingdotgg/t3code/pulls/42",
    );
    assert.strictEqual(request?.headers.authorization, "token abc");
  }).pipe(Effect.provide(layer));
});

it.effect("accepts a configured host that carries a scheme", () => {
  const { execute, layer } = makeLayer({
    host: "https://git.test.local/",
    response: () => Response.json(forgejoPullRequest),
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    yield* forgejo.getPullRequest({ cwd: "/repo", reference: "42" });

    assert.strictEqual(
      execute.mock.calls[0]?.[0].url,
      "https://git.test.local/api/v1/repos/pingdotgg/t3code/pulls/42",
    );
  }).pipe(Effect.provide(layer));
});

it.effect("resolves a pull request from its web url", () => {
  const { execute, layer } = makeLayer({
    response: () => Response.json(forgejoPullRequest),
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    yield* forgejo.getPullRequest({
      cwd: "/repo",
      reference: "https://codeberg.org/pingdotgg/t3code/pulls/42",
    });

    assert.strictEqual(
      execute.mock.calls[0]?.[0].url,
      "https://git.test.local/api/v1/repos/pingdotgg/t3code/pulls/42",
    );
  }).pipe(Effect.provide(layer));
});

it.effect("lists merged pull requests as closed ones that Forgejo reports merged", () => {
  const { execute, layer } = makeLayer({
    response: () =>
      Response.json([
        {
          ...forgejoPullRequest,
          number: 7,
          state: "closed",
          merged: true,
          head: { ref: "feature/merged", repo: { full_name: "pingdotgg/t3code" } },
        },
        {
          ...forgejoPullRequest,
          number: 8,
          state: "closed",
          merged: false,
          head: { ref: "feature/merged", repo: { full_name: "pingdotgg/t3code" } },
        },
      ]),
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    const result = yield* forgejo.listPullRequests({
      cwd: "/repo",
      headSelector: "feature/merged",
      state: "merged",
      limit: 10,
    });

    assert.deepStrictEqual(
      result.map((record) => [record.number, record.state]),
      [[7, "merged"]],
    );
    const request = execute.mock.calls[0]?.[0];
    assert.strictEqual(request?.url, "https://git.test.local/api/v1/repos/pingdotgg/t3code/pulls");
    assert.deepStrictEqual(request?.urlParams.params, [
      ["state", "closed"],
      ["sort", "recentupdate"],
      ["limit", "10"],
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("lists closed pull requests without the merged ones", () => {
  const { execute, layer } = makeLayer({
    response: () =>
      Response.json([
        {
          ...forgejoPullRequest,
          number: 7,
          state: "closed",
          merged: true,
          head: { ref: "feature/closed", repo: { full_name: "pingdotgg/t3code" } },
        },
        {
          ...forgejoPullRequest,
          number: 8,
          state: "closed",
          merged: false,
          head: { ref: "feature/closed", repo: { full_name: "pingdotgg/t3code" } },
        },
      ]),
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    const result = yield* forgejo.listPullRequests({
      cwd: "/repo",
      headSelector: "feature/closed",
      state: "closed",
      limit: 10,
    });

    assert.deepStrictEqual(
      result.map((record) => [record.number, record.state]),
      [[8, "closed"]],
    );
    assert.deepStrictEqual(execute.mock.calls[0]?.[0].urlParams.params, [
      ["state", "closed"],
      ["sort", "recentupdate"],
      ["limit", "10"],
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("narrows an all-state listing to the head branch and its owner", () => {
  const { execute, layer } = makeLayer({
    response: () =>
      Response.json([
        forgejoPullRequest,
        {
          ...forgejoPullRequest,
          number: 43,
          head: {
            ref: "feature/source-control",
            repo: { full_name: "pingdotgg/t3code", owner: { login: "pingdotgg" } },
          },
        },
        {
          ...forgejoPullRequest,
          number: 44,
          head: { ref: "feature/other", repo: { full_name: "octocat/t3code" } },
        },
      ]),
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    const result = yield* forgejo.listPullRequests({
      cwd: "/repo",
      headSelector: "octocat:feature/source-control",
      state: "all",
      limit: 10,
    });

    assert.deepStrictEqual(
      result.map((record) => record.number),
      [42],
    );
    assert.deepStrictEqual(execute.mock.calls[0]?.[0].urlParams.params, [
      ["state", "all"],
      ["sort", "recentupdate"],
      ["limit", "10"],
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("reads repository clone URLs and default branch", () => {
  const { execute, layer } = makeLayer({
    response: () => Response.json(repositoryJson),
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    const cloneUrls = yield* forgejo.getRepositoryCloneUrls({
      cwd: "/repo",
      repository: "pingdotgg/t3code",
    });
    const defaultBranch = yield* forgejo.getDefaultBranch({ cwd: "/repo" });

    assert.deepStrictEqual(cloneUrls, {
      nameWithOwner: "pingdotgg/t3code",
      url: "https://codeberg.org/pingdotgg/t3code.git",
      sshUrl: "git@codeberg.org:pingdotgg/t3code.git",
    });
    assert.strictEqual(defaultBranch, "main");
    assert.deepStrictEqual(
      execute.mock.calls.map((call) => call[0].url),
      [
        "https://git.test.local/api/v1/repos/pingdotgg/t3code",
        "https://git.test.local/api/v1/repos/pingdotgg/t3code",
      ],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("reports no default branch when the repository has none", () => {
  const { layer } = makeLayer({
    response: () => Response.json({ ...repositoryJson, default_branch: null }),
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    const defaultBranch = yield* forgejo.getDefaultBranch({ cwd: "/repo" });

    assert.strictEqual(defaultBranch, null);
  }).pipe(Effect.provide(layer));
});

it.effect("creates a repository under the signed-in user through the Forgejo REST API", () => {
  const { execute, layer } = makeLayer({
    response: (request) =>
      request.url.endsWith("/user")
        ? Response.json({ login: "pingdotgg" })
        : Response.json(repositoryJson),
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    const cloneUrls = yield* forgejo.createRepository({
      cwd: "/repo",
      repository: "pingdotgg/t3code",
      visibility: "private",
    });

    assert.deepStrictEqual(cloneUrls, {
      nameWithOwner: "pingdotgg/t3code",
      url: "https://codeberg.org/pingdotgg/t3code.git",
      sshUrl: "git@codeberg.org:pingdotgg/t3code.git",
    });

    assert.strictEqual(execute.mock.calls[0]?.[0].url, "https://git.test.local/api/v1/user");
    const request = execute.mock.calls[1]?.[0];
    assert.strictEqual(request?.url, "https://git.test.local/api/v1/user/repos");
    assert.strictEqual(request?.method, "POST");
    assert.ok(request);
    assert.deepStrictEqual(decodeBody(request), {
      name: "t3code",
      private: true,
    });
  }).pipe(Effect.provide(layer));
});

it.effect("creates a repository under an organization the viewer is not", () => {
  const { execute, layer } = makeLayer({
    response: (request) =>
      request.url.endsWith("/user")
        ? Response.json({ login: "octocat" })
        : Response.json(repositoryJson),
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    yield* forgejo.createRepository({
      cwd: "/repo",
      repository: "pingdotgg/t3code",
      visibility: "public",
    });

    const request = execute.mock.calls[1]?.[0];
    assert.strictEqual(request?.url, "https://git.test.local/api/v1/orgs/pingdotgg/repos");
    assert.strictEqual(request?.method, "POST");
    assert.ok(request);
    assert.deepStrictEqual(decodeBody(request), {
      name: "t3code",
      private: false,
    });
  }).pipe(Effect.provide(layer));
});

it.effect("rejects a repository name without an owner", () => {
  const { execute, layer } = makeLayer({
    response: () => Response.json(repositoryJson),
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    const error = yield* Effect.flip(
      forgejo.createRepository({ cwd: "/repo", repository: "t3code", visibility: "public" }),
    );

    assert.instanceOf(error, ForgejoApi.ForgejoRepositoryLocatorError);
    assert.strictEqual(
      error.message,
      "Forgejo API failed in createRepository: Forgejo repositories must be specified as owner/repository.",
    );
    assert.strictEqual(execute.mock.calls.length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("creates pull requests using the official REST payload shape", () => {
  const { execute, layer } = makeLayer({
    response: () => Response.json(forgejoPullRequest),
  });

  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const bodyFile = yield* fileSystem.makeTempFileScoped({ prefix: "forgejo-pr-body-" });
    yield* fileSystem.writeFileString(bodyFile, "PR body");

    const forgejo = yield* ForgejoApi.ForgejoApi;
    yield* forgejo.createPullRequest({
      cwd: "/repo",
      baseBranch: "main",
      headSelector: "owner:feature/provider",
      title: "Provider PR",
      bodyFile,
    });

    const request = execute.mock.calls[0]?.[0];
    assert.strictEqual(request?.url, "https://git.test.local/api/v1/repos/pingdotgg/t3code/pulls");
    assert.strictEqual(request?.method, "POST");
    assert.ok(request);
    assert.deepStrictEqual(decodeBody(request), {
      title: "Provider PR",
      body: "PR body",
      head: "owner:feature/provider",
      base: "main",
    });
  }).pipe(Effect.provide(layer), Effect.scoped);
});

it.effect("reports auth status through the Forgejo REST /user endpoint", () => {
  const { execute, layer } = makeLayer({
    response: () => Response.json({ login: "forgejo-user" }),
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    const auth = yield* forgejo.probeAuth;

    assert.deepStrictEqual(auth, {
      status: "authenticated",
      account: Option.some("forgejo-user"),
      host: Option.some("git.test.local"),
      detail: Option.none(),
    });
    assert.strictEqual(execute.mock.calls[0]?.[0].url, "https://git.test.local/api/v1/user");
  }).pipe(Effect.provide(layer));
});

it.effect("falls back to the configured token when the /user probe fails", () => {
  const { layer } = makeLayer({
    response: () => new Response("nope", { status: 401 }),
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    const auth = yield* forgejo.probeAuth;

    assert.deepStrictEqual(auth, {
      status: "unknown",
      account: Option.none(),
      host: Option.some("git.test.local"),
      detail: Option.some("Forgejo token is configured."),
    });
  }).pipe(Effect.provide(layer));
});

it.effect("names the configured user when the token cannot read /user", () => {
  const { layer } = makeLayer({
    response: () => new Response("forbidden", { status: 403 }),
    user: "forgejo-user",
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    const auth = yield* forgejo.probeAuth;

    assert.deepStrictEqual(auth, {
      status: "unknown",
      account: Option.some("forgejo-user"),
      host: Option.some("git.test.local"),
      detail: Option.some("Forgejo token is configured."),
    });
  }).pipe(Effect.provide(layer));
});

it.effect("points at T3CODE_FORGEJO_USER when /user is refused and no user is configured", () => {
  const { layer } = makeLayer({
    response: () => new Response("forbidden", { status: 403 }),
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    const auth = yield* forgejo.probeAuth;

    assert.strictEqual(auth.status, "unknown");
    assert.deepStrictEqual(auth.account, Option.none());
    assert.deepStrictEqual(
      auth.detail,
      Option.some(
        "The token cannot read the user profile. Grant it read access to user, or set T3CODE_FORGEJO_USER.",
      ),
    );
  }).pipe(Effect.provide(layer));
});

it.effect("preserves the HTTP client failure without deriving the domain message from it", () => {
  const transportCause = new Error("socket reset by peer");
  let requestFailure: HttpClientError.HttpClientError | undefined;
  const { layer } = makeLayer({
    response: () => Response.json({}),
    requestFailure: (request) => {
      requestFailure = new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({
          request,
          cause: transportCause,
        }),
      });
      return requestFailure;
    },
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    const error = yield* Effect.flip(
      forgejo.getPullRequest({
        cwd: "/repo",
        reference: "42",
      }),
    );

    assert.instanceOf(error, ForgejoApi.ForgejoRequestError);
    assert.strictEqual(error.operation, "getPullRequest");
    assert.strictEqual(
      error.message,
      "Forgejo API failed in getPullRequest: Failed to send the Forgejo request.",
    );
    assert.strictEqual(error.cause, requestFailure);
    assert.strictEqual(requestFailure?.cause, transportCause);
  }).pipe(Effect.provide(layer));
});

it.effect("keeps Forgejo response bodies out of checkout diagnostics", () => {
  const responseBody = '{"message":"credential=secret-value"}';
  const { layer } = makeLayer({
    response: () => new Response(responseBody, { status: 403 }),
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    const error = yield* forgejo
      .checkoutPullRequest({ cwd: "/repo", reference: "42" })
      .pipe(Effect.flip);

    assert.instanceOf(error, ForgejoApi.ForgejoResponseError);
    assert.strictEqual(error.operation, "getPullRequest");
    assert.strictEqual(error.status, 403);
    assert.strictEqual(error.responseBodyLength, responseBody.length);
    assert.notProperty(error, "responseBody");
    assert.strictEqual(
      error.message,
      "Forgejo API failed in getPullRequest: Forgejo returned HTTP 403.",
    );
    assert.notInclude(error.message, "secret-value");
  }).pipe(Effect.provide(layer));
});

it.effect("maps a 401 to a response error carrying the status", () => {
  const { layer } = makeLayer({
    response: () => new Response("unauthorized", { status: 401 }),
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    const error = yield* forgejo
      .request({ method: "GET", url: "/repos/acme/web" })
      .pipe(Effect.flip);

    assert.instanceOf(error, ForgejoApi.ForgejoResponseError);
    assert.strictEqual(error.status, 401);
    assert.strictEqual(error.retryAt, undefined);
  }).pipe(Effect.provide(layer));
});

it.effect("keeps a 429 Retry-After time on the response error", () => {
  const { layer } = makeLayer({
    response: () => new Response("busy", { status: 429, headers: { "Retry-After": "120" } }),
  });

  return Effect.gen(function* () {
    yield* TestClock.setTime(1_000);
    const forgejo = yield* ForgejoApi.ForgejoApi;
    const error = yield* forgejo
      .request({ method: "GET", url: "/repos/acme/web" })
      .pipe(Effect.flip);

    assert.instanceOf(error, ForgejoApi.ForgejoResponseError);
    assert.strictEqual(error.status, 429);
    assert.strictEqual(error.retryAt, 121_000);
  }).pipe(Effect.provide(layer));
});

it.effect("preserves Forgejo response body read failures as their immediate cause", () => {
  const cause = new Error("response stream failed");
  const { layer } = makeLayer({
    response: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => controller.error(cause),
        }),
        { status: 502 },
      ),
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    const error = yield* forgejo
      .getPullRequest({ cwd: "/repo", reference: "42" })
      .pipe(Effect.flip);

    assert.instanceOf(error, ForgejoApi.ForgejoResponseBodyReadError);
    assert.strictEqual(error.operation, "getPullRequest");
    assert.strictEqual(error.status, 502);
    assert.instanceOf(error.cause, HttpClientError.HttpClientError);
    assert.strictEqual(error.cause.cause, cause);
    assert.strictEqual(
      error.message,
      "Forgejo API failed in getPullRequest: Forgejo returned HTTP 502.",
    );
  }).pipe(Effect.provide(layer));
});

it.effect("checks out same-repository pull requests with the existing Forgejo remote", () => {
  const { git, layer } = makeLayer({
    response: () =>
      Response.json({
        ...forgejoPullRequest,
        head: {
          ref: "feature/source-control",
          repo: { full_name: "pingdotgg/t3code", owner: { login: "pingdotgg" } },
        },
      }),
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    yield* forgejo.checkoutPullRequest({
      cwd: "/repo",
      context: {
        provider: {
          kind: "forgejo",
          name: "Codeberg",
          baseUrl: "https://codeberg.org",
        },
        remoteName: "origin",
        remoteUrl: "git@codeberg.org:pingdotgg/t3code.git",
      },
      reference: "42",
      force: true,
    });

    assert.strictEqual(git.ensureRemote.mock.calls.length, 0);
    assert.deepStrictEqual(git.fetchRemoteBranch.mock.calls[0]?.[0], {
      cwd: "/repo",
      remoteName: "origin",
      remoteBranch: "feature/source-control",
      localBranch: "feature/source-control",
    });
    assert.deepStrictEqual(git.setBranchUpstream.mock.calls[0]?.[0], {
      cwd: "/repo",
      branch: "feature/source-control",
      remoteName: "origin",
      remoteBranch: "feature/source-control",
    });
    assert.deepStrictEqual(git.switchRef.mock.calls[0]?.[0], {
      cwd: "/repo",
      refName: "feature/source-control",
    });
  }).pipe(Effect.provide(layer));
});

it.effect("preserves Git checkout failures without deriving the domain message from them", () => {
  const gitCause = new GitCommandError({
    operation: "fetchRemoteBranch",
    command: "git fetch origin feature/source-control",
    cwd: "/repo",
    detail: "remote rejected the request",
  });
  const { layer } = makeLayer({
    response: () =>
      Response.json({
        ...forgejoPullRequest,
        head: {
          ref: "feature/source-control",
          repo: { full_name: "pingdotgg/t3code", owner: { login: "pingdotgg" } },
        },
      }),
    git: {
      fetchRemoteBranch: () => Effect.fail(gitCause),
    },
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    const error = yield* Effect.flip(
      forgejo.checkoutPullRequest({
        cwd: "/repo",
        reference: "42",
        force: true,
      }),
    );

    assert.instanceOf(error, ForgejoApi.ForgejoCheckoutError);
    assert.strictEqual(error.cwd, "/repo");
    assert.strictEqual(error.reference, "42");
    assert.strictEqual(
      error.message,
      "Forgejo API failed in checkoutPullRequest: Failed to check out the Forgejo pull request.",
    );
    assert.strictEqual(error.cause, gitCause);
  }).pipe(Effect.provide(layer));
});

it.effect("checks out fork pull requests through an ensured fork remote", () => {
  const { git, layer } = makeLayer({
    response: (request) => {
      if (request.url.endsWith("/repos/octocat/t3code")) {
        return Response.json({
          ...repositoryJson,
          full_name: "octocat/t3code",
          html_url: "https://codeberg.org/octocat/t3code",
          clone_url: "https://codeberg.org/octocat/t3code.git",
          ssh_url: "git@codeberg.org:octocat/t3code.git",
          owner: { login: "octocat" },
        });
      }
      return Response.json({
        ...forgejoPullRequest,
        head: {
          ref: "main",
          repo: { full_name: "octocat/t3code", owner: { login: "octocat" } },
        },
      });
    },
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    yield* forgejo.checkoutPullRequest({
      cwd: "/repo",
      reference: "42",
      force: true,
    });

    assert.deepStrictEqual(git.ensureRemote.mock.calls[0]?.[0], {
      cwd: "/repo",
      preferredName: "octocat",
      url: "git@codeberg.org:octocat/t3code.git",
    });
    assert.deepStrictEqual(git.fetchRemoteBranch.mock.calls[0]?.[0], {
      cwd: "/repo",
      remoteName: "octocat",
      remoteBranch: "main",
      localBranch: "t3code/pr-42/main",
    });
    assert.deepStrictEqual(git.setBranchUpstream.mock.calls[0]?.[0], {
      cwd: "/repo",
      branch: "t3code/pr-42/main",
      remoteName: "octocat",
      remoteBranch: "main",
    });
    assert.deepStrictEqual(git.switchRef.mock.calls[0]?.[0], {
      cwd: "/repo",
      refName: "t3code/pr-42/main",
    });
  }).pipe(Effect.provide(layer));
});

it.effect("refuses a url that points away from the configured Forgejo", () => {
  // A whole url reaches `request` from inside a response — a pagination link, say — so
  // following one off-host would hand the account's credentials to whoever wrote it.
  const { layer, execute } = makeLayer({ response: () => new Response("{}", { status: 200 }) });
  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;

    const error = yield* Effect.flip(
      forgejo.request({ method: "GET", url: "https://attacker.example/api/v1/repos" }),
    );

    assert.strictEqual(error._tag, "ForgejoUntrustedUrlError");
    // Nothing was sent at all, so no header travelled anywhere.
    assert.strictEqual(execute.mock.calls.length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("keeps only the host of a url it refuses, never its query", () =>
  Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;

    const error = yield* Effect.flip(
      forgejo.request({
        method: "GET",
        // A signed link, whose query is the credential.
        url: "https://attacker.example/asset?signature=secret-token",
      }),
    );

    assert.strictEqual(error._tag, "ForgejoUntrustedUrlError");
    assert.strictEqual(
      error._tag === "ForgejoUntrustedUrlError" ? error.host : "",
      "https://attacker.example",
    );
    assert.notInclude(error.message, "secret-token");
  }).pipe(Effect.provide(makeLayer({ response: () => new Response("{}", { status: 200 }) }).layer)),
);

it.effect("does not follow a redirect off the configured Forgejo", () =>
  Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;

    const error = yield* Effect.flip(
      forgejo.request({ method: "GET", url: "/repos/acme/web/pulls/1.diff" }),
    );

    // The client would carry every header to the new host, so the hop is checked here instead.
    assert.strictEqual(error._tag, "ForgejoUntrustedUrlError");
  }).pipe(
    Effect.provide(
      makeLayer({
        response: () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://attacker.example/stolen" },
          }),
      }).layer,
    ),
  ),
);

it.effect("follows a redirect that stays on the configured Forgejo", () =>
  Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;

    const result = yield* forgejo.request({
      method: "GET",
      url: "/repos/acme/web/pulls/1.diff",
    });

    // Forgejo may answer a diff with a redirect, so the hop has to be followed.
    assert.strictEqual(result.body, "diff --git a/a.ts b/a.ts");
    assert.isFalse(result.truncated);
  }).pipe(
    Effect.provide(
      makeLayer({
        response: (request) =>
          request.url.endsWith("/pulls/1.diff")
            ? new Response(null, {
                status: 302,
                // The same host the harness configures, which is not codeberg.org: a
                // self-hosted instance has to be trusted on its own terms.
                headers: { location: "https://git.test.local/acme/web/pulls/1/files.diff" },
              })
            : new Response("diff --git a/a.ts b/a.ts", { status: 200 }),
      }).layer,
    ),
  ),
);

it.effect("cuts a response short rather than reading an unbounded diff into memory", () =>
  Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;

    const result = yield* forgejo.request({
      method: "GET",
      url: "/repos/acme/web/pulls/1.diff",
      maxBytes: 8,
    });

    assert.strictEqual(result.body, "12345678");
    assert.isTrue(result.truncated);
    // Bounded as the body arrives, so an oversized diff is never held whole.
  }).pipe(
    Effect.provide(
      makeLayer({ response: () => new Response("1234567890", { status: 200 }) }).layer,
    ),
  ),
);
