import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  NonNegativeInt,
  TrimmedNonEmptyString,
  type SourceControlProviderAuth,
  type SourceControlRepositoryCloneUrls,
  type SourceControlRepositoryVisibility,
} from "@t3tools/contracts";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { sanitizeBranchFragment } from "@t3tools/shared/git";
import {
  detectSourceControlProviderFromRemoteUrl,
  isSshRemoteUrl,
} from "@t3tools/shared/sourceControl";

import {
  ForgejoPullRequestListSchema,
  ForgejoPullRequestSchema,
  normalizeForgejoPullRequestRecord,
  type NormalizedForgejoPullRequestRecord,
} from "./forgejoPullRequests.ts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import { retryAtFromHeader } from "./SourceControlRateLimit.ts";

/** A response body past this is cut short, so one huge diff cannot exhaust the server. */
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** Forgejo may answer a diff with a redirect; this leaves room without following a chain forever. */
const MAX_REDIRECTS = 3;

/**
 * The Forgejo instance the server talks to. Codeberg unless configured, since a self-hosted
 * Forgejo or Gitea cannot be told apart from any other git host by its remote url alone.
 */
export const ForgejoHostConfig = Config.string("T3CODE_FORGEJO_HOST").pipe(
  Config.withDefault("codeberg.org"),
);

const ForgejoApiEnvConfig = Config.all({
  host: ForgejoHostConfig,
  token: Config.string("T3CODE_FORGEJO_TOKEN").pipe(Config.option),
  /**
   * The login the token belongs to, for a token that cannot read `/user`. Forgejo tokens are
   * often minted without `read:user`, every repository endpoint still works, and no other
   * endpoint reveals the token's owner.
   */
  user: Config.string("T3CODE_FORGEJO_USER").pipe(Config.option),
});

const ForgejoApiOperation = Schema.Literals([
  "resolveRepository",
  "getRepository",
  "getPullRequest",
  "listPullRequests",
  "createRepository",
  "createPullRequest",
  "probeAuth",
  "checkoutPullRequest",
  // The raw escape hatch. Callers name their own operation in their own error, the way the
  // pull request wrappers do on top of `gh` and `glab`.
  "request",
]);
type ForgejoApiOperation = typeof ForgejoApiOperation.Type;

export class ForgejoRepositoryLocatorError extends Schema.TaggedErrorClass<ForgejoRepositoryLocatorError>()(
  "ForgejoRepositoryLocatorError",
  {
    repository: Schema.String,
  },
) {
  get detail(): string {
    return "Forgejo repositories must be specified as owner/repository.";
  }

  override get message(): string {
    return `Forgejo API failed in createRepository: ${this.detail}`;
  }
}

export class ForgejoRequestError extends Schema.TaggedErrorClass<ForgejoRequestError>()(
  "ForgejoRequestError",
  {
    operation: ForgejoApiOperation,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return "Failed to send the Forgejo request.";
  }

  override get message(): string {
    return `Forgejo API failed in ${this.operation}: ${this.detail}`;
  }
}

export class ForgejoResponseError extends Schema.TaggedErrorClass<ForgejoResponseError>()(
  "ForgejoResponseError",
  {
    operation: ForgejoApiOperation,
    status: Schema.Int,
    responseBodyLength: NonNegativeInt,
    retryAt: Schema.optional(Schema.Number),
  },
) {
  get detail(): string {
    return `Forgejo returned HTTP ${this.status}.`;
  }

  override get message(): string {
    return `Forgejo API failed in ${this.operation}: ${this.detail}`;
  }
}

export class ForgejoResponseBodyReadError extends Schema.TaggedErrorClass<ForgejoResponseBodyReadError>()(
  "ForgejoResponseBodyReadError",
  {
    operation: ForgejoApiOperation,
    status: Schema.Int,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `Forgejo returned HTTP ${this.status}.`;
  }

  override get message(): string {
    return `Forgejo API failed in ${this.operation}: ${this.detail}`;
  }
}

export class ForgejoResponseDecodeError extends Schema.TaggedErrorClass<ForgejoResponseDecodeError>()(
  "ForgejoResponseDecodeError",
  {
    operation: ForgejoApiOperation,
    status: Schema.Int,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return "Forgejo returned invalid JSON for the requested resource.";
  }

  override get message(): string {
    return `Forgejo API failed in ${this.operation}: ${this.detail}`;
  }
}

export class ForgejoRepositoryVcsResolveError extends Schema.TaggedErrorClass<ForgejoRepositoryVcsResolveError>()(
  "ForgejoRepositoryVcsResolveError",
  {
    cwd: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `Failed to resolve VCS repository for ${this.cwd}.`;
  }

  override get message(): string {
    return `Forgejo API failed in resolveRepository: ${this.detail}`;
  }
}

export class ForgejoRepositoryRemotesListError extends Schema.TaggedErrorClass<ForgejoRepositoryRemotesListError>()(
  "ForgejoRepositoryRemotesListError",
  {
    cwd: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `Failed to list remotes for ${this.cwd}.`;
  }

  override get message(): string {
    return `Forgejo API failed in resolveRepository: ${this.detail}`;
  }
}

export class ForgejoRepositoryRemoteNotFoundError extends Schema.TaggedErrorClass<ForgejoRepositoryRemoteNotFoundError>()(
  "ForgejoRepositoryRemoteNotFoundError",
  {
    cwd: Schema.String,
  },
) {
  get detail(): string {
    return `No Forgejo repository remote was detected for ${this.cwd}.`;
  }

  override get message(): string {
    return `Forgejo API failed in resolveRepository: ${this.detail}`;
  }
}

export class ForgejoPullRequestBodyReadError extends Schema.TaggedErrorClass<ForgejoPullRequestBodyReadError>()(
  "ForgejoPullRequestBodyReadError",
  {
    cwd: Schema.String,
    bodyFile: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `Failed to read pull request body file ${this.bodyFile}.`;
  }

  override get message(): string {
    return `Forgejo API failed in createPullRequest: ${this.detail}`;
  }
}

export class ForgejoCheckoutError extends Schema.TaggedErrorClass<ForgejoCheckoutError>()(
  "ForgejoCheckoutError",
  {
    cwd: Schema.String,
    reference: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return "Failed to check out the Forgejo pull request.";
  }

  override get message(): string {
    return `Forgejo API failed in checkoutPullRequest: ${this.detail}`;
  }
}

/**
 * A url that does not belong to the configured Forgejo. Refused rather than followed, because
 * the request carries the account's credentials and a url that came back in a response — a
 * pagination link, or the target of a redirect — is not this server's to trust.
 */
export class ForgejoUntrustedUrlError extends Schema.TaggedErrorClass<ForgejoUntrustedUrlError>()(
  "ForgejoUntrustedUrlError",
  {
    /** The host only. A rejected hop is often a signed url, whose query carries a credential. */
    host: Schema.String,
  },
) {
  get detail(): string {
    return `The response pointed at ${this.host}, outside the configured Forgejo.`;
  }

  override get message(): string {
    return `Forgejo API failed in request: ${this.detail}`;
  }
}

export const ForgejoApiError = Schema.Union([
  ForgejoUntrustedUrlError,
  ForgejoRepositoryLocatorError,
  ForgejoRequestError,
  ForgejoResponseError,
  ForgejoResponseBodyReadError,
  ForgejoResponseDecodeError,
  ForgejoRepositoryVcsResolveError,
  ForgejoRepositoryRemotesListError,
  ForgejoRepositoryRemoteNotFoundError,
  ForgejoPullRequestBodyReadError,
  ForgejoCheckoutError,
]);
export type ForgejoApiError = typeof ForgejoApiError.Type;
export const isForgejoApiError = Schema.is(ForgejoApiError);

const RawForgejoRepositorySchema = Schema.Struct({
  full_name: TrimmedNonEmptyString,
  html_url: TrimmedNonEmptyString,
  clone_url: Schema.optional(TrimmedNonEmptyString),
  ssh_url: Schema.optional(TrimmedNonEmptyString),
  default_branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  owner: Schema.optional(
    Schema.Struct({
      login: TrimmedNonEmptyString,
    }),
  ),
});

const ForgejoUserSchema = Schema.Struct({
  login: Schema.optional(TrimmedNonEmptyString),
  full_name: Schema.optional(TrimmedNonEmptyString),
});

export interface ForgejoRepositoryLocator {
  readonly owner: string;
  readonly repo: string;
}

export class ForgejoApi extends Context.Service<
  ForgejoApi,
  {
    readonly probeAuth: Effect.Effect<SourceControlProviderAuth, never>;

    /** `T3CODE_FORGEJO_USER`: who the token belongs to, when `/user` cannot say. */
    readonly configuredUser: Option.Option<string>;

    /**
     * One authenticated request, returning the body verbatim. Forgejo answers most endpoints
     * with JSON and a few — a pull request diff, for one — with plain text, so the body is
     * handed back undecoded for the caller to read as it sees fit.
     */
    readonly request: (input: {
      readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      /**
       * A path below the API base, or a whole URL as a paged response reports its next page.
       * A whole URL is refused unless it belongs to the configured Forgejo.
       */
      readonly url: string;
      /** A JSON document, for the endpoints that take one. */
      readonly body?: string;
      /** Response bytes to keep; past this the body comes back cut short and marked. */
      readonly maxBytes?: number;
    }) => Effect.Effect<{ readonly body: string; readonly truncated: boolean }, ForgejoApiError>;
    readonly listPullRequests: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
      readonly headSelector: string;
      readonly source?: SourceControlProvider.SourceControlRefSelector;
      readonly state: "open" | "closed" | "merged" | "all";
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<NormalizedForgejoPullRequestRecord>, ForgejoApiError>;
    readonly getPullRequest: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
      readonly reference: string;
    }) => Effect.Effect<NormalizedForgejoPullRequestRecord, ForgejoApiError>;
    readonly getRepositoryCloneUrls: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
      readonly repository: string;
    }) => Effect.Effect<SourceControlRepositoryCloneUrls, ForgejoApiError>;
    readonly createRepository: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly visibility: SourceControlRepositoryVisibility;
    }) => Effect.Effect<SourceControlRepositoryCloneUrls, ForgejoApiError>;
    readonly createPullRequest: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
      readonly baseBranch: string;
      readonly headSelector: string;
      readonly source?: SourceControlProvider.SourceControlRefSelector;
      readonly target?: SourceControlProvider.SourceControlRefSelector;
      readonly title: string;
      readonly bodyFile: string;
    }) => Effect.Effect<void, ForgejoApiError>;
    readonly getDefaultBranch: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
    }) => Effect.Effect<string | null, ForgejoApiError>;
    readonly checkoutPullRequest: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
      readonly reference: string;
      readonly force?: boolean;
    }) => Effect.Effect<void, ForgejoApiError>;
  }
>()("t3/sourceControl/ForgejoApi") {}

function nonEmpty(value: string | undefined): Option.Option<string> {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? Option.none() : Option.some(trimmed);
}

function normalizeChangeRequestId(reference: string): string {
  const trimmed = reference.trim().replace(/^#/, "");
  const urlMatch = /(?:pulls|pull|pr)\/(\d+)(?:\D.*)?$/i.exec(trimmed);
  return urlMatch?.[1] ?? trimmed;
}

function sourceOwner(input: {
  readonly headSelector: string;
  readonly source?: SourceControlProvider.SourceControlRefSelector;
}): string | undefined {
  if (input.source?.owner) return input.source.owner;
  return SourceControlProvider.parseSourceControlOwnerRef(input.headSelector)?.owner;
}

/** Forgejo knows only open and closed; merged is a closed pull request with `merged` set. */
function toForgejoState(state: "open" | "closed" | "merged" | "all"): string {
  return state === "merged" ? "closed" : state;
}

function matchesRequestedState(
  record: NormalizedForgejoPullRequestRecord,
  state: "open" | "closed" | "merged" | "all",
): boolean {
  switch (state) {
    case "merged":
      return record.state === "merged";
    case "closed":
      return record.state === "closed";
    case "open":
    case "all":
      return true;
  }
}

function parseForgejoRepositorySlug(value: string): ForgejoRepositoryLocator | null {
  const normalized = value.trim().replace(/\.git$/u, "");
  const parts = normalized.split("/").filter((part) => part.length > 0);
  if (parts.length < 2) return null;
  const owner = parts.at(-2);
  const repo = parts.at(-1);
  return owner && repo ? { owner, repo } : null;
}

function requireRepositoryLocator(
  repository: string,
): Effect.Effect<ForgejoRepositoryLocator, ForgejoApiError> {
  const locator = parseForgejoRepositorySlug(repository);
  return locator
    ? Effect.succeed(locator)
    : Effect.fail(
        new ForgejoRepositoryLocatorError({
          repository,
        }),
      );
}

function parseForgejoRemoteUrl(remoteUrl: string): ForgejoRepositoryLocator | null {
  const trimmed = remoteUrl.trim();
  const scpMatch = /^[a-zA-Z0-9._-]+@[^:/]+:(.+)$/.exec(trimmed);
  if (scpMatch?.[1]) {
    return parseForgejoRepositorySlug(scpMatch[1]);
  }

  try {
    return parseForgejoRepositorySlug(new URL(trimmed).pathname);
  } catch {
    return null;
  }
}

function normalizeRepositoryCloneUrls(
  raw: typeof RawForgejoRepositorySchema.Type,
): SourceControlRepositoryCloneUrls {
  const url = raw.clone_url ?? raw.html_url;
  return {
    nameWithOwner: raw.full_name,
    url,
    sshUrl: raw.ssh_url ?? url,
  };
}

function shouldPreferSshRemote(originRemoteUrl: string | null): boolean {
  if (!originRemoteUrl) return false;
  return isSshRemoteUrl(originRemoteUrl);
}

function selectCloneUrl(input: {
  readonly cloneUrls: SourceControlRepositoryCloneUrls;
  readonly originRemoteUrl: string | null;
}): string {
  return shouldPreferSshRemote(input.originRemoteUrl)
    ? input.cloneUrls.sshUrl
    : input.cloneUrls.url;
}

function checkoutBranchName(input: {
  readonly pullRequestId: number;
  readonly headBranch: string;
  readonly isCrossRepository: boolean;
}): string {
  if (!input.isCrossRepository) {
    return input.headBranch;
  }

  return `t3code/pr-${input.pullRequestId}/${sanitizeBranchFragment(input.headBranch)}`;
}

function repositoryNameWithOwner(
  repository: Schema.Schema.Type<typeof ForgejoPullRequestSchema>["head"]["repo"],
): string | null {
  const fullName = repository?.full_name?.trim() ?? "";
  return fullName.length > 0 ? fullName : null;
}

function repositoryOwnerName(repositoryName: string): string {
  return repositoryName.split("/")[0]?.trim() || "forgejo";
}

/**
 * What can be said about the credentials once `/user` has refused to say. A 403 is a token
 * without `read:user`, which every repository endpoint still accepts, so it is not reported as
 * a bad token — only as one whose owner must be named another way.
 */
function authFromConfig(
  config: Config.Success<typeof ForgejoApiEnvConfig>,
  failure: ForgejoApiError,
): SourceControlProviderAuth {
  if (Option.isSome(config.token)) {
    const scopeRefused =
      failure._tag === "ForgejoResponseError" &&
      failure.status === 403 &&
      Option.isNone(config.user);
    return {
      status: "unknown",
      account: config.user,
      host: Option.some(config.host),
      detail: Option.some(
        scopeRefused
          ? "The token cannot read the user profile. Grant it read access to user, or set T3CODE_FORGEJO_USER."
          : "Forgejo token is configured.",
      ),
    };
  }

  return {
    status: "unauthenticated",
    account: Option.none(),
    host: Option.some(config.host),
    detail: Option.some("Set T3CODE_FORGEJO_TOKEN."),
  };
}

/** Null for anything that is not a url at all, which is never the configured Forgejo. */
function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function responseError(
  operation: ForgejoApiOperation,
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<never, ForgejoApiError> {
  // Bounded like any other body: an error response is no smaller than a successful one, and
  // only its length is reported anyway.
  return Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const collected = yield* collectUint8StreamText({
      stream: response.stream,
      maxBytes: DEFAULT_MAX_RESPONSE_BYTES,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ForgejoResponseBodyReadError({
            operation,
            status: response.status,
            cause,
          }),
      ),
    );
    return yield* new ForgejoResponseError({
      operation,
      status: response.status,
      responseBodyLength: collected.text.length,
      retryAt: retryAtFromHeader(response.headers["retry-after"], now),
    });
  });
}

export const make = Effect.gen(function* () {
  const config = yield* ForgejoApiEnvConfig;
  const httpClient = yield* HttpClient.HttpClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;

  // The host may be given with a scheme; the API always lives at /api/v1 over https.
  const baseUrl = `https://${config.host.replace(/^https?:\/\//u, "").replace(/\/+$/u, "")}/api/v1`;
  const apiUrl = (path: string) => `${baseUrl}${path}`;

  const withAuth = (request: HttpClientRequest.HttpClientRequest) =>
    Option.isSome(config.token)
      ? request.pipe(HttpClientRequest.setHeader("Authorization", `token ${config.token.value}`))
      : request;

  const decodeResponse = <S extends Schema.Top>(
    operation: ForgejoApiOperation,
    schema: S,
    response: HttpClientResponse.HttpClientResponse,
  ): Effect.Effect<S["Type"], ForgejoApiError, S["DecodingServices"]> =>
    HttpClientResponse.matchStatus({
      "2xx": (success) =>
        HttpClientResponse.schemaBodyJson(schema)(success).pipe(
          Effect.mapError(
            (cause) =>
              new ForgejoResponseDecodeError({
                operation,
                status: success.status,
                cause,
              }),
          ),
        ),
      orElse: (failed) => responseError(operation, failed),
    })(response);

  const executeJson = <S extends Schema.Top>(
    operation: ForgejoApiOperation,
    request: HttpClientRequest.HttpClientRequest,
    schema: S,
  ): Effect.Effect<S["Type"], ForgejoApiError, S["DecodingServices"]> =>
    httpClient.execute(withAuth(request.pipe(HttpClientRequest.acceptJson))).pipe(
      Effect.mapError(
        (cause) =>
          new ForgejoRequestError({
            operation,
            cause,
          }),
      ),
      Effect.flatMap((response) => decodeResponse(operation, schema, response)),
    );

  const repositoryPath = (repository: ForgejoRepositoryLocator) =>
    `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;

  const resolveRepository = Effect.fn("ForgejoApi.resolveRepository")(function* (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly repository?: string;
  }) {
    const fromRepository =
      input.repository !== undefined ? parseForgejoRepositorySlug(input.repository) : null;
    if (fromRepository) return fromRepository;

    const fromContext =
      input.context?.provider.kind === "forgejo"
        ? parseForgejoRemoteUrl(input.context.remoteUrl)
        : null;
    if (fromContext) return fromContext;

    const handle = yield* vcsRegistry.resolve({ cwd: input.cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new ForgejoRepositoryVcsResolveError({
            cwd: input.cwd,
            cause,
          }),
      ),
    );
    const remotes = yield* handle.driver.listRemotes(input.cwd).pipe(
      Effect.mapError(
        (cause) =>
          new ForgejoRepositoryRemotesListError({
            cwd: input.cwd,
            cause,
          }),
      ),
    );

    for (const remote of remotes.remotes) {
      if (
        detectSourceControlProviderFromRemoteUrl(remote.url, { forgejoHost: config.host })?.kind !==
        "forgejo"
      ) {
        continue;
      }
      const parsed = parseForgejoRemoteUrl(remote.url);
      if (parsed) return parsed;
    }

    return yield* new ForgejoRepositoryRemoteNotFoundError({
      cwd: input.cwd,
    });
  });

  const getRepositoryFromLocator = (repository: ForgejoRepositoryLocator) =>
    executeJson(
      "getRepository",
      HttpClientRequest.get(apiUrl(repositoryPath(repository))),
      RawForgejoRepositorySchema,
    );

  const getRepository = (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly repository?: string;
  }) => resolveRepository(input).pipe(Effect.flatMap(getRepositoryFromLocator));

  const getRawPullRequestFromRepository = (
    repository: ForgejoRepositoryLocator,
    reference: string,
  ) =>
    executeJson(
      "getPullRequest",
      HttpClientRequest.get(
        apiUrl(
          `${repositoryPath(repository)}/pulls/${encodeURIComponent(normalizeChangeRequestId(reference))}`,
        ),
      ),
      ForgejoPullRequestSchema,
    );

  const getRawPullRequest = (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly reference: string;
  }) =>
    resolveRepository(input).pipe(
      Effect.flatMap((repository) => getRawPullRequestFromRepository(repository, input.reference)),
    );

  const readConfigValueNullable = (cwd: string, key: string) =>
    git.readConfigValue(cwd, key).pipe(Effect.orElseSucceed(() => null));

  const resolveCheckoutRemote = Effect.fn("ForgejoApi.resolveCheckoutRemote")(function* (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly destinationRepository: ForgejoRepositoryLocator;
    readonly sourceRepositoryName: string;
    readonly isCrossRepository: boolean;
  }) {
    if (
      input.context?.provider.kind === "forgejo" &&
      !input.isCrossRepository &&
      parseForgejoRemoteUrl(input.context.remoteUrl) !== null
    ) {
      return input.context.remoteName;
    }

    if (!input.isCrossRepository) {
      const remoteName = yield* git
        .resolvePrimaryRemoteName(input.cwd)
        .pipe(Effect.orElseSucceed(() => null));
      if (remoteName) return remoteName;
    }

    const cloneUrls = yield* getRepository({
      cwd: input.cwd,
      repository: input.sourceRepositoryName,
      ...(input.context ? { context: input.context } : {}),
    }).pipe(Effect.map(normalizeRepositoryCloneUrls));
    const originRemoteUrl = yield* readConfigValueNullable(input.cwd, "remote.origin.url");
    return yield* git.ensureRemote({
      cwd: input.cwd,
      preferredName: input.isCrossRepository
        ? repositoryOwnerName(input.sourceRepositoryName)
        : input.destinationRepository.owner,
      url: selectCloneUrl({ cloneUrls, originRemoteUrl }),
    });
  });

  /**
   * The one host these credentials may be sent to. A url that came back inside a response — a
   * pagination link, or the target of a redirect — is data, not instruction, so it is checked
   * against this before the account's token travels with it.
   */
  const apiOrigin = originOf(baseUrl);

  const trustedUrl = (value: string): string | null => {
    if (!/^https?:\/\//u.test(value)) return apiUrl(value);
    const origin = originOf(value);
    return origin !== null && origin === apiOrigin ? value : null;
  };

  /**
   * Redirects are followed here rather than by the client, which forwards every header to
   * whatever host it is sent to. Forgejo may answer a diff with a redirect, so the hop has to
   * be followed — but only back to the same Forgejo.
   */
  const send = (input: {
    readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    readonly url: string;
    readonly body?: string;
    readonly redirects: number;
  }): Effect.Effect<HttpClientResponse.HttpClientResponse, ForgejoApiError> => {
    const url = trustedUrl(input.url);
    if (url === null) {
      return Effect.fail(
        new ForgejoUntrustedUrlError({ host: originOf(input.url) ?? "an unreadable url" }),
      );
    }
    const base =
      input.method === "GET"
        ? HttpClientRequest.get(url)
        : input.method === "POST"
          ? HttpClientRequest.post(url)
          : input.method === "DELETE"
            ? HttpClientRequest.make("DELETE")(url)
            : input.method === "PATCH"
              ? HttpClientRequest.patch(url)
              : HttpClientRequest.put(url);
    // No `Accept: application/json`: the diff endpoints answer with a patch, not JSON.
    const withBody =
      input.body === undefined
        ? base
        : base.pipe(HttpClientRequest.bodyText(input.body, "application/json"));
    return httpClient.execute(withAuth(withBody)).pipe(
      Effect.mapError(
        (cause): ForgejoApiError => new ForgejoRequestError({ operation: "request", cause }),
      ),
      Effect.flatMap((response) => {
        const location = response.headers.location;
        if (
          response.status >= 300 &&
          response.status < 400 &&
          location !== undefined &&
          input.redirects < MAX_REDIRECTS
        ) {
          return send({
            ...input,
            url: new URL(location, url).toString(),
            redirects: input.redirects + 1,
          });
        }
        return Effect.succeed(response);
      }),
    );
  };

  const request: ForgejoApi["Service"]["request"] = (input) =>
    send({ ...input, redirects: 0 }).pipe(
      Effect.flatMap((response) =>
        HttpClientResponse.matchStatus({
          // Read through the body stream rather than `text`, so an oversized diff is stopped
          // as it arrives instead of being materialized whole and then cut. The same collector
          // the process runner bounds command output with.
          "2xx": (success) =>
            collectUint8StreamText({
              stream: success.stream,
              maxBytes: input.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ForgejoResponseBodyReadError({
                    operation: "request",
                    status: success.status,
                    cause,
                  }),
              ),
              Effect.map((collected) => ({
                body: collected.text,
                truncated: collected.truncated,
              })),
            ),
          orElse: (failed) => responseError("request", failed),
        })(response),
      ),
    );

  const getViewer = (operation: ForgejoApiOperation) =>
    executeJson(operation, HttpClientRequest.get(apiUrl("/user")), ForgejoUserSchema);

  return ForgejoApi.of({
    request,
    configuredUser: config.user,
    probeAuth: getViewer("probeAuth").pipe(
      Effect.map((user) => ({
        status: "authenticated" as const,
        account: nonEmpty(user.login ?? user.full_name),
        host: Option.some(config.host),
        detail: Option.none<string>(),
      })),
      Effect.catch((failure) => Effect.succeed(authFromConfig(config, failure))),
    ),
    // Forgejo cannot filter a listing by head branch, so the page is fetched sorted by recent
    // activity and narrowed here.
    listPullRequests: (input) =>
      resolveRepository(input).pipe(
        Effect.flatMap((repository) =>
          executeJson(
            "listPullRequests",
            HttpClientRequest.get(apiUrl(`${repositoryPath(repository)}/pulls`), {
              urlParams: {
                state: toForgejoState(input.state),
                sort: "recentupdate",
                limit: String(Math.max(1, Math.min(input.limit ?? 20, 50))),
              },
            }),
            ForgejoPullRequestListSchema,
          ),
        ),
        Effect.map((list) => {
          const headBranch = SourceControlProvider.sourceBranch(input);
          const owner = sourceOwner(input);
          return list
            .map(normalizeForgejoPullRequestRecord)
            .filter(
              (record) =>
                record.headRefName === headBranch &&
                (owner === undefined || record.headRepositoryOwnerLogin === owner) &&
                matchesRequestedState(record, input.state),
            );
        }),
      ),
    getPullRequest: (input) =>
      getRawPullRequest(input).pipe(Effect.map(normalizeForgejoPullRequestRecord)),
    getRepositoryCloneUrls: (input) =>
      getRepository(input).pipe(Effect.map(normalizeRepositoryCloneUrls)),
    // A repository is created under the signed-in user or under an organization, and the two
    // live at different endpoints, so the viewer is looked up to tell them apart.
    createRepository: (input) =>
      Effect.gen(function* () {
        const repository = yield* requireRepositoryLocator(input.repository);
        const viewer = yield* getViewer("createRepository");
        const path =
          viewer.login === repository.owner
            ? "/user/repos"
            : `/orgs/${encodeURIComponent(repository.owner)}/repos`;
        return yield* executeJson(
          "createRepository",
          HttpClientRequest.post(apiUrl(path)).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              name: repository.repo,
              private: input.visibility === "private",
            }),
          ),
          RawForgejoRepositorySchema,
        );
      }).pipe(Effect.map(normalizeRepositoryCloneUrls)),
    createPullRequest: (input) =>
      Effect.gen(function* () {
        const repository = yield* resolveRepository(input);
        const description = yield* fileSystem.readFileString(input.bodyFile).pipe(
          Effect.mapError(
            (cause) =>
              new ForgejoPullRequestBodyReadError({
                cwd: input.cwd,
                bodyFile: input.bodyFile,
                cause,
              }),
          ),
        );
        const owner = sourceOwner(input);
        const headBranch = SourceControlProvider.sourceBranch(input);
        const body = {
          title: input.title,
          body: description,
          // A head in another repository is written `owner:branch`.
          head: owner ? `${owner}:${headBranch}` : headBranch,
          base: input.target?.refName ?? input.baseBranch,
        };

        yield* executeJson(
          "createPullRequest",
          HttpClientRequest.post(apiUrl(`${repositoryPath(repository)}/pulls`)).pipe(
            HttpClientRequest.bodyJsonUnsafe(body),
          ),
          ForgejoPullRequestSchema,
        );
      }),
    getDefaultBranch: (input) =>
      getRepository(input).pipe(Effect.map((repository) => repository.default_branch ?? null)),
    // Forgejo pull requests are Git-backed and Forgejo does not provide an official checkout
    // CLI. This provider-local path uses GitVcsDriver as a narrow escape hatch to materialize
    // Forgejo PR refs. Do not generalize this as the source-control provider model: if we
    // support non-Git-compatible hosting providers or native JJ/Sapling checkout flows, move
    // this into a VCS-specific change-request checkout capability.
    checkoutPullRequest: (input) =>
      Effect.gen(function* () {
        const destinationRepository = yield* resolveRepository(input);
        const pullRequest = yield* getRawPullRequestFromRepository(
          destinationRepository,
          input.reference,
        );
        const destinationRepositoryName =
          repositoryNameWithOwner(pullRequest.base.repo) ??
          `${destinationRepository.owner}/${destinationRepository.repo}`;
        const sourceRepositoryName =
          repositoryNameWithOwner(pullRequest.head.repo) ?? destinationRepositoryName;
        const isCrossRepository = sourceRepositoryName !== destinationRepositoryName;
        const remoteName = yield* resolveCheckoutRemote({
          cwd: input.cwd,
          destinationRepository,
          sourceRepositoryName,
          isCrossRepository,
          ...(input.context ? { context: input.context } : {}),
        });
        const remoteBranch = pullRequest.head.ref;
        const localBranch = checkoutBranchName({
          pullRequestId: pullRequest.number,
          headBranch: remoteBranch,
          isCrossRepository,
        });
        const localBranchNames = yield* git.listLocalBranchNames(input.cwd);
        const localBranchExists = localBranchNames.includes(localBranch);

        if (input.force === true || !localBranchExists) {
          yield* git.fetchRemoteBranch({
            cwd: input.cwd,
            remoteName,
            remoteBranch,
            localBranch,
          });
        } else {
          yield* git.fetchRemoteTrackingBranch({
            cwd: input.cwd,
            remoteName,
            remoteBranch,
          });
        }

        yield* git.setBranchUpstream({
          cwd: input.cwd,
          branch: localBranch,
          remoteName,
          remoteBranch,
        });
        yield* Effect.scoped(git.switchRef({ cwd: input.cwd, refName: localBranch }));
      }).pipe(
        Effect.mapError((cause) =>
          isForgejoApiError(cause)
            ? cause
            : new ForgejoCheckoutError({
                cwd: input.cwd,
                reference: input.reference,
                cause,
              }),
        ),
      ),
  });
});

export const layer = Layer.effect(ForgejoApi, make);
