import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  PullRequestAction,
  PullRequestCheck,
  PullRequestComment,
  PullRequestCommit,
  PullRequestListState,
  PullRequestMergeMethod,
  PullRequestMergeability,
  PullRequestReaction,
  PullRequestReactionContent,
  PullRequestReviewCommentDraft,
  PullRequestReviewPosition,
  PullRequestReviewThread,
  PullRequestReviewVerdict,
  PullRequestReviewerCandidateList,
} from "@t3tools/contracts";

import * as ForgejoApi from "../sourceControl/ForgejoApi.ts";
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
  type ForgejoDiffStat,
  type ForgejoPullRequest,
  type ForgejoRawReviewComment,
} from "./forgejoPullRequestJson.ts";
import type { ProviderListCursor } from "./PullRequestProvider.ts";

/**
 * Names the read that produced unusable output, so a failure reports the call it came from
 * rather than borrowing another operation's message.
 */
export class ForgejoPullRequestReadError extends Schema.TaggedErrorClass<ForgejoPullRequestReadError>()(
  "ForgejoPullRequestReadError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `Forgejo returned an unreadable ${this.operation} response.`;
  }

  override get message(): string {
    return `Forgejo failed in ${this.operation}: ${this.detail}`;
  }
}

/** Not a decode failure: Forgejo answered, the account it answered for just has no handle. */
export class ForgejoViewerUnavailableError extends Schema.TaggedErrorClass<ForgejoViewerUnavailableError>()(
  "ForgejoViewerUnavailableError",
  {},
) {
  get detail(): string {
    return "Forgejo returned no account name for the configured credentials.";
  }

  override get message(): string {
    return `Forgejo failed in getViewer: ${this.detail}`;
  }
}

/** A repository that is not `owner/repo`, which is the only form Forgejo addresses. */
export class ForgejoRepositoryUnsupportedError extends Schema.TaggedErrorClass<ForgejoRepositoryUnsupportedError>()(
  "ForgejoRepositoryUnsupportedError",
  {
    repository: Schema.String,
  },
) {
  get detail(): string {
    return "A Forgejo repository is addressed as owner/repository.";
  }

  override get message(): string {
    return `Forgejo failed in resolveRepository: ${this.detail}`;
  }
}

/** Not a decode failure: the reader named a commit that is not a sha this repository could hold. */
export class ForgejoDiffCommitError extends Schema.TaggedErrorClass<ForgejoDiffCommitError>()(
  "ForgejoDiffCommitError",
  {},
) {
  get detail(): string {
    return "The named commit was not a commit sha.";
  }

  override get message(): string {
    return `Forgejo failed in getPullRequestDiff: ${this.detail}`;
  }
}

/** An action the provider never declares, so the surface never offers it. */
export class ForgejoActionUnsupportedError extends Schema.TaggedErrorClass<ForgejoActionUnsupportedError>()(
  "ForgejoActionUnsupportedError",
  {
    action: Schema.String,
  },
) {
  get detail(): string {
    return `Forgejo does not support the ${this.action} action.`;
  }

  override get message(): string {
    return `Forgejo failed in runAction: ${this.detail}`;
  }
}

export type ForgejoPullRequestApiError =
  | ForgejoApi.ForgejoApiError
  | ForgejoPullRequestReadError
  | ForgejoViewerUnavailableError
  | ForgejoRepositoryUnsupportedError
  | ForgejoDiffCommitError
  | ForgejoActionUnsupportedError;

/**
 * Forgejo's default ceiling on `limit`. Asking for more is clamped silently to whatever the
 * instance allows, so this is a number to respect rather than to push against.
 */
const MAX_PAGE_SIZE = 50;
/** The page size for pull request conversations, commits, and collaborators. */
const CONVERSATION_PAGE_SIZE = 50;
/**
 * Pages of the conversation to follow before it is reported as truncated. Forgejo serves fifty
 * comments a page, so this is five hundred — beyond any pull request a person is reading, and an
 * end to a walk whose only other stop is Forgejo running out.
 */
const CONVERSATION_PAGES = 10;
/** The same ceiling the gh and glab diff reads use. */
const DIFF_MAX_BYTES = 8 * 1024 * 1024;
/** Reaction reads in flight at once: one per comment, so the conversation's length is the count. */
const REACTION_CONCURRENCY = 5;

export interface ForgejoPullRequestBatch {
  readonly items: ReadonlyArray<ForgejoPullRequest>;
  readonly truncated: boolean;
  /** Raw Forgejo rows consumed to produce this batch, including the ones filtered out. */
  readonly cursorAdvance: number;
}

export class ForgejoPullRequestApi extends Context.Service<
  ForgejoPullRequestApi,
  {
    /** A function rather than a value, so the request is built per call and not at layer time. */
    readonly getViewer: () => Effect.Effect<string, ForgejoPullRequestApiError>;

    readonly listPullRequests: (input: {
      readonly repository: string;
      readonly state: PullRequestListState;
      readonly limit: number;
      /** Free text, matched against a pull request's title and body. */
      readonly query?: string | undefined;
      /** Where to carry on from, as the count of rows already consumed. */
      readonly cursor?: ProviderListCursor | undefined;
    }) => Effect.Effect<ForgejoPullRequestBatch, ForgejoPullRequestApiError>;

    readonly getPullRequest: (input: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<ForgejoPullRequest, ForgejoPullRequestApiError>;

    /** True where the credentials can push to the repository, which is what merging needs. */
    readonly getRepositoryPermission: (input: {
      readonly repository: string;
    }) => Effect.Effect<boolean, ForgejoPullRequestApiError>;

    readonly getPullRequestDiff: (input: {
      readonly repository: string;
      readonly number: number;
      /** One commit's own changes, rather than everything the pull request carries. */
      readonly commit?: string | undefined;
    }) => Effect.Effect<
      { readonly patch: string; readonly truncated: boolean },
      ForgejoPullRequestApiError
    >;

    /** The line counts, read off the pull request itself — `getPullRequest` already carries them. */
    readonly getDiffStat: (input: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<ForgejoDiffStat, ForgejoPullRequestApiError>;

    /** Read off the pull request itself — `getPullRequest` already carries it. */
    readonly getMergeability: (input: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<PullRequestMergeability, ForgejoPullRequestApiError>;

    /**
     * The whole conversation: the plain remarks, every submitted review, and the line comments
     * each review carries — the last assembled into threads by the line they sit on. Each remark
     * and line comment carries its reactions, and `reactions` is the pull request's own.
     */
    readonly listComments: (input: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<
      {
        readonly comments: ReadonlyArray<PullRequestComment>;
        readonly threads: ReadonlyArray<PullRequestReviewThread>;
        readonly truncated: boolean;
        readonly reactions: ReadonlyArray<PullRequestReaction>;
      },
      ForgejoPullRequestApiError
    >;

    readonly listCommits: (input: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<ReadonlyArray<PullRequestCommit>, ForgejoPullRequestApiError>;

    /**
     * The statuses on the pull request's head commit. The commit is read off the pull request
     * unless the caller already holds it, which saves the round trip.
     */
    readonly listChecks: (input: {
      readonly repository: string;
      readonly number: number;
      readonly headSha?: string | null | undefined;
    }) => Effect.Effect<ReadonlyArray<PullRequestCheck>, ForgejoPullRequestApiError>;

    /**
     * Who this pull request may be sent to, and who it has already been sent to. Two reads at
     * once, because Forgejo keeps the people on the repository and the reviewers on the pull
     * request, and neither answers for the other.
     */
    readonly listReviewerCandidates: (input: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<PullRequestReviewerCandidateList, ForgejoPullRequestApiError>;

    readonly setReviewerRequest: (input: {
      readonly repository: string;
      readonly number: number;
      readonly reviewers: ReadonlyArray<{ readonly id: string }>;
      readonly requested: boolean;
    }) => Effect.Effect<void, ForgejoPullRequestApiError>;

    readonly runAction: (input: {
      readonly repository: string;
      readonly number: number;
      readonly action: PullRequestAction;
      readonly mergeMethod?: PullRequestMergeMethod;
    }) => Effect.Effect<void, ForgejoPullRequestApiError>;

    readonly updateChangeRequest: (input: {
      readonly repository: string;
      readonly number: number;
      readonly title?: string | undefined;
      readonly body?: string | undefined;
    }) => Effect.Effect<void, ForgejoPullRequestApiError>;

    readonly comment: (input: {
      readonly repository: string;
      readonly number: number;
      readonly body: string;
    }) => Effect.Effect<void, ForgejoPullRequestApiError>;

    readonly updateComment: (input: {
      readonly repository: string;
      readonly number: number;
      readonly commentId: string;
      readonly body: string;
    }) => Effect.Effect<void, ForgejoPullRequestApiError>;

    readonly submitReview: (input: {
      readonly repository: string;
      readonly number: number;
      readonly verdict: PullRequestReviewVerdict;
      readonly body: string;
      readonly comments: ReadonlyArray<PullRequestReviewCommentDraft>;
    }) => Effect.Effect<void, ForgejoPullRequestApiError>;

    /**
     * Answers a thread, named by its root comment. Forgejo has no reply of its own, so the answer
     * is a new line comment on the same line, which `listComments` folds into the same thread; an
     * id that names no thread is answered as a plain remark on the pull request.
     */
    readonly replyToComment: (input: {
      readonly repository: string;
      readonly number: number;
      readonly commentId: string;
      readonly body: string;
    }) => Effect.Effect<void, ForgejoPullRequestApiError>;

    /** Adds a reaction, or takes it back; absent `commentId` means the pull request itself. */
    readonly setReaction: (input: {
      readonly repository: string;
      readonly number: number;
      readonly commentId?: string | undefined;
      readonly content: PullRequestReactionContent;
      readonly active: boolean;
    }) => Effect.Effect<void, ForgejoPullRequestApiError>;
  }
>()("t3/pullRequest/ForgejoPullRequestApi") {}

/** `owner/repo`; Forgejo has no deeper nesting to address. */
function repositorySegments(
  repository: string,
): Result.Result<
  { readonly owner: string; readonly repo: string },
  ForgejoRepositoryUnsupportedError
> {
  const segments = repository
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  const [owner, repo] = segments;
  if (segments.length !== 2 || owner === undefined || repo === undefined) {
    return Result.fail(new ForgejoRepositoryUnsupportedError({ repository }));
  }
  return Result.succeed({ owner, repo });
}

function repositoryPathOf(segments: { readonly owner: string; readonly repo: string }): string {
  return `/repos/${encodeURIComponent(segments.owner)}/${encodeURIComponent(segments.repo)}`;
}

/**
 * A commit sha arrives from the reader and goes straight into a request path, so it is checked
 * rather than trusted: hexadecimal only, from the shortest abbreviation a host prints up to a
 * whole sha.
 */
function isCommitSha(value: string): boolean {
  return /^[0-9a-f]{7,64}$/i.test(value);
}

/**
 * Forgejo knows only open and closed, so merged is asked for as closed and narrowed afterwards,
 * and closed has its merged rows taken out.
 */
function stateParam(state: PullRequestListState): string {
  switch (state) {
    case "open":
      return "open";
    case "merged":
    case "closed":
      return "closed";
    case "all":
      return "all";
  }
}

function matchesState(pullRequest: ForgejoPullRequest, state: PullRequestListState): boolean {
  switch (state) {
    case "merged":
      return pullRequest.state === "merged";
    case "closed":
      return pullRequest.state === "closed";
    case "open":
    case "all":
      return true;
  }
}

/** Forgejo's merge strategies, which happen to share the contract's three names. */
function mergeStrategy(method: PullRequestMergeMethod | undefined): string {
  switch (method) {
    case "squash":
      return "squash";
    case "rebase":
      return "rebase";
    default:
      return "merge";
  }
}

function reviewEvent(verdict: PullRequestReviewVerdict): string {
  switch (verdict) {
    case "approve":
      return "APPROVED";
    case "request-changes":
      return "REQUEST_CHANGES";
    case "comment":
      return "COMMENT";
  }
}

function forgejoReviewPosition(
  position: PullRequestReviewPosition,
): { readonly old_position: number } | { readonly new_position: number } {
  switch (position.kind) {
    case "added":
      return { new_position: position.newLine };
    case "deleted":
      return { old_position: position.oldLine };
    case "context":
      return position.side === "left"
        ? { old_position: position.oldLine }
        : { new_position: position.newLine };
  }
}

function query(params: ReadonlyArray<readonly [string, string]>): string {
  return params
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

/** One page of a listing, decoded, with where each row sat in Forgejo's raw answer. */
interface ListPage {
  readonly items: ReadonlyArray<ForgejoPullRequest>;
  readonly rawIndexes: ReadonlyArray<number>;
  readonly rawCount: number;
}

export const make = Effect.gen(function* () {
  const forgejo = yield* ForgejoApi.ForgejoApi;

  const withRepository = <A>(
    repository: string,
    use: (
      path: string,
      segments: { readonly owner: string; readonly repo: string },
    ) => Effect.Effect<A, ForgejoPullRequestApiError>,
  ): Effect.Effect<A, ForgejoPullRequestApiError> => {
    const segments = repositorySegments(repository);
    return Result.isSuccess(segments)
      ? use(repositoryPathOf(segments.success), segments.success)
      : Effect.fail(segments.failure);
  };

  const readPage = <A>(input: {
    readonly operation: string;
    readonly url: string;
    readonly decode: (body: string) => Result.Result<A, unknown>;
  }): Effect.Effect<A, ForgejoPullRequestApiError> =>
    forgejo.request({ method: "GET", url: input.url }).pipe(
      Effect.flatMap((response) => {
        const decoded = input.decode(response.body);
        return Result.isSuccess(decoded)
          ? Effect.succeed(decoded.success)
          : Effect.fail(
              new ForgejoPullRequestReadError({
                operation: input.operation,
                cause: decoded.failure,
              }),
            );
      }),
    );

  const getPullRequest = (path: string, number: number) =>
    readPage({
      operation: "getPullRequest",
      url: `${path}/pulls/${number}`,
      decode: decodePullRequestJson,
    });

  /**
   * Forgejo pages by offset, so a larger page is walked one request at a time, the way the
   * GitLab listing is. The walk is bounded twice over: it stops on a short page or once the
   * extra row that reveals a next page has been read, and it never asks for more pages than the
   * caller's page needs. The second bound is what makes it terminate when every row on a page is
   * filtered out, which leaves nothing collected but does not mean Forgejo has run out of rows.
   *
   * A continuation carries on from `delivered`, the count of raw rows already consumed — the
   * state filter and the repository filter of a search both drop rows the offset still counts.
   */
  const listPage = (input: {
    readonly fetch: (
      page: number,
      perPage: number,
    ) => Effect.Effect<ListPage, ForgejoPullRequestApiError>;
    readonly state: PullRequestListState;
    readonly limit: number;
    readonly cursor?: ProviderListCursor | undefined;
    readonly page: number;
    readonly collected: ReadonlyArray<ForgejoPullRequest>;
    readonly cursorAdvance: number;
  }): Effect.Effect<ForgejoPullRequestBatch, ForgejoPullRequestApiError> => {
    const delivered = input.cursor?.delivered ?? 0;
    const perPage = Math.min(input.limit + 1, MAX_PAGE_SIZE);
    const firstPage = Math.floor(delivered / perPage) + 1;
    const skipOnFirstPage = input.page === firstPage ? delivered % perPage : 0;
    const lastPage = Math.floor((delivered + input.limit) / perPage) + 1;
    return input.fetch(input.page, perPage).pipe(
      Effect.flatMap((decoded) => {
        const pageItems: ForgejoPullRequest[] = [];
        const pageRawIndexes: number[] = [];
        for (const [index, item] of decoded.items.entries()) {
          const rawIndex = decoded.rawIndexes[index]!;
          if (rawIndex < skipOnFirstPage) continue;
          if (!matchesState(item, input.state)) continue;
          pageItems.push(item);
          pageRawIndexes.push(rawIndex);
        }
        const remaining = input.limit - input.collected.length;
        const lastItemRawIndex = pageRawIndexes[remaining - 1];
        if (lastItemRawIndex !== undefined) {
          const consumed = lastItemRawIndex + 1 - skipOnFirstPage;
          return Effect.succeed({
            items: [...input.collected, ...pageItems.slice(0, remaining)],
            truncated: lastItemRawIndex + 1 < decoded.rawCount || decoded.rawCount === perPage,
            cursorAdvance: input.cursorAdvance + consumed,
          });
        }
        const collected = [...input.collected, ...pageItems];
        const consumed = Math.max(0, decoded.rawCount - skipOnFirstPage);
        // Counted before decoding, so a skipped malformed row cannot end paging early.
        const exhausted = decoded.rawCount < perPage;
        if (exhausted) {
          return Effect.succeed({
            items: collected,
            truncated: false,
            cursorAdvance: input.cursorAdvance + consumed,
          });
        }
        if (input.page >= lastPage) {
          return Effect.succeed({
            items: collected,
            truncated: true,
            cursorAdvance: input.cursorAdvance + consumed,
          });
        }
        return listPage({
          ...input,
          page: input.page + 1,
          collected,
          cursorAdvance: input.cursorAdvance + consumed,
        });
      }),
    );
  };

  /** Walks an offset-paged list to its end or to the page cap, and combines every decoded item. */
  const itemPages = <A>(input: {
    readonly operation: string;
    readonly url: string;
    readonly decode: (
      body: string,
    ) => Result.Result<{ readonly items: ReadonlyArray<A>; readonly rawCount: number }, unknown>;
    readonly page: number;
    readonly items: ReadonlyArray<A>;
    /** Commit pages are individually oldest-first, so older pages are prepended. */
    readonly prepend: boolean;
  }): Effect.Effect<
    { readonly items: ReadonlyArray<A>; readonly truncated: boolean },
    ForgejoPullRequestApiError
  > =>
    readPage({
      operation: input.operation,
      url: `${input.url}?${query([
        ["limit", String(CONVERSATION_PAGE_SIZE)],
        ["page", String(input.page)],
      ])}`,
      decode: input.decode,
    }).pipe(
      Effect.flatMap((page) => {
        const items = input.prepend
          ? [...page.items, ...input.items]
          : [...input.items, ...page.items];
        if (page.rawCount < CONVERSATION_PAGE_SIZE) {
          return Effect.succeed({ items, truncated: false });
        }
        if (input.page >= CONVERSATION_PAGES) {
          return Effect.succeed({ items, truncated: true });
        }
        return itemPages({ ...input, page: input.page + 1, items });
      }),
    );

  /**
   * The threads a pull request carries, which `replyToComment` needs to find the line a reply
   * belongs on. Threads are assembled once every review has been read rather than per review,
   * because two remarks on one line can come from two different reviews.
   */
  const listConversation = (path: string, number: number) =>
    Effect.all(
      [
        itemPages({
          operation: "listComments",
          url: `${path}/issues/${number}/comments`,
          decode: decodeCommentsJson,
          page: 1,
          items: [],
          prepend: false,
        }),
        itemPages({
          operation: "listReviews",
          url: `${path}/pulls/${number}/reviews`,
          decode: decodeReviewsJson,
          page: 1,
          items: [],
          prepend: false,
        }).pipe(
          Effect.flatMap((reviews) =>
            Effect.forEach(
              reviews.items.filter((review) => review.hasComments),
              (review) =>
                readPage({
                  operation: "listReviewComments",
                  url: `${path}/pulls/${number}/reviews/${review.id}/comments`,
                  decode: decodeReviewCommentsJson,
                }),
              { concurrency: 4 },
            ).pipe(
              Effect.map((reviewComments) => ({
                reviews: reviews.items.flatMap((review) =>
                  review.comment === null ? [] : [review.comment],
                ),
                lineComments: reviewComments.flatMap((page) => page.comments),
                entries: reviewComments.flatMap(
                  (page): ReadonlyArray<ForgejoRawReviewComment> => page.entries,
                ),
                truncated: reviews.truncated,
              })),
            ),
          ),
        ),
      ],
      { concurrency: 2 },
    ).pipe(
      Effect.map(([issueComments, reviews]) => ({
        comments: [...issueComments.items, ...reviews.reviews, ...reviews.lineComments].toSorted(
          (left, right) => left.createdAt.localeCompare(right.createdAt),
        ),
        threads: buildReviewThreads(reviews.entries),
        truncated: issueComments.truncated || reviews.truncated,
      })),
    );

  const postReview = (
    path: string,
    number: number,
    body: {
      readonly event: string;
      readonly body: string;
      readonly comments: ReadonlyArray<Record<string, unknown>>;
    },
  ) =>
    forgejo
      .request({
        method: "POST",
        url: `${path}/pulls/${number}/reviews`,
        body: JSON.stringify(body),
      })
      .pipe(Effect.asVoid);

  const postComment = (path: string, number: number, body: string) =>
    forgejo
      .request({
        method: "POST",
        url: `${path}/issues/${number}/comments`,
        // A JSON document rather than a form field, so the body stays text whatever it says.
        body: JSON.stringify({ body }),
      })
      .pipe(Effect.asVoid);

  const getViewer = (): Effect.Effect<string, ForgejoPullRequestApiError> =>
    forgejo.request({ method: "GET", url: "/user" }).pipe(
      Effect.flatMap((response): Effect.Effect<string, ForgejoPullRequestApiError> => {
        const decoded = decodeViewerJson(response.body);
        if (!Result.isSuccess(decoded)) {
          return Effect.fail(
            new ForgejoPullRequestReadError({ operation: "getViewer", cause: decoded.failure }),
          );
        }
        return decoded.success === null
          ? Effect.fail(new ForgejoViewerUnavailableError())
          : Effect.succeed(decoded.success);
      }),
    );

  /** The reactions on one subject; a read that fails costs that subject its reactions, no more. */
  const readReactions = (url: string, viewer: string | null) =>
    readPage({
      operation: "listReactions",
      // Forgejo pages reactions like any list and clamps the limit at its own ceiling, so past
      // fifty reactions on one subject the rest are not counted.
      url: `${url}?${query([
        ["limit", String(MAX_PAGE_SIZE)],
        ["page", "1"],
      ])}`,
      decode: (body) => decodeReactionsJson(body, viewer),
    }).pipe(Effect.orElseSucceed((): ReadonlyArray<PullRequestReaction> => []));

  /**
   * The reactions on the pull request and on each comment named — one request per comment, since
   * Forgejo carries none of them on the comment itself. The viewer is read first so their own
   * reactions read back as theirs; a token without `read:user` is refused at `/user`, and then
   * every reaction is shown as someone else's rather than none being shown at all.
   */
  const listReactions = (path: string, number: number, commentIds: ReadonlyArray<string>) =>
    getViewer().pipe(
      Effect.orElseSucceed((): string | null => null),
      Effect.flatMap((viewer) =>
        Effect.all(
          [
            readReactions(`${path}/issues/${number}/reactions`, viewer),
            Effect.forEach(
              commentIds,
              (id) =>
                readReactions(
                  `${path}/issues/comments/${encodeURIComponent(id)}/reactions`,
                  viewer,
                ).pipe(Effect.map((reactions) => [id, reactions] as const)),
              { concurrency: REACTION_CONCURRENCY },
            ),
          ],
          { concurrency: 2 },
        ),
      ),
      Effect.map(([reactions, byComment]) => ({
        reactions,
        reactionsByCommentId: new Map(byComment),
      })),
    );

  /**
   * The conversation with its reactions attached. Reviews are left as they are: a review's id is
   * not a comment id, so Forgejo has nothing to read for it under `/issues/comments`.
   */
  const listComments = (path: string, number: number) =>
    listConversation(path, number).pipe(
      Effect.flatMap((conversation) => {
        const commentIds = conversation.comments.flatMap((comment) =>
          comment.kind === "review" ? [] : [comment.id],
        );
        return listReactions(path, number, commentIds).pipe(
          Effect.map((reactions) => ({
            ...conversation,
            reactions: reactions.reactions,
            comments: conversation.comments.map((comment) =>
              comment.kind === "review"
                ? comment
                : { ...comment, reactions: reactions.reactionsByCommentId.get(comment.id) ?? [] },
            ),
            threads: conversation.threads.map((thread) => ({
              ...thread,
              comments: thread.comments.map((comment) => ({
                ...comment,
                reactions: reactions.reactionsByCommentId.get(comment.id) ?? [],
              })),
            })),
          })),
        );
      }),
    );

  return ForgejoPullRequestApi.of({
    getViewer,

    listPullRequests: (input) =>
      withRepository(input.repository, (path, segments) => {
        const search = input.query?.trim() ?? "";
        const repository = `${segments.owner}/${segments.repo}`.toLowerCase();
        const fetch =
          search.length === 0
            ? (page: number, perPage: number) =>
                readPage({
                  operation: "listPullRequests",
                  url: `${path}/pulls?${query([
                    ["state", stateParam(input.state)],
                    ["sort", "recentupdate"],
                    ["limit", String(perPage)],
                    ["page", String(page)],
                  ])}`,
                  decode: decodePullRequestPageJson,
                })
            : // The repository's own listing takes no search term, so the words go to the
              // issue search, which spans the owner's repositories and answers with issues.
              // Its hits are narrowed to this repository and each is then read as a pull
              // request, since a hit carries neither branch.
              (page: number, perPage: number) =>
                readPage({
                  operation: "listPullRequests",
                  url: `/repos/issues/search?${query([
                    ["type", "pulls"],
                    ["q", search],
                    ["owner", segments.owner],
                    ["state", stateParam(input.state)],
                    ["limit", String(perPage)],
                    ["page", String(page)],
                  ])}`,
                  decode: decodeSearchJson,
                }).pipe(
                  Effect.flatMap((hits) => {
                    const own = hits.items.flatMap((hit, index) =>
                      hit.repository?.toLowerCase() === repository
                        ? [{ number: hit.number, rawIndex: hits.rawIndexes[index]! }]
                        : [],
                    );
                    return Effect.forEach(own, (hit) => getPullRequest(path, hit.number), {
                      concurrency: 4,
                    }).pipe(
                      Effect.map(
                        (items): ListPage => ({
                          items,
                          rawIndexes: own.map((hit) => hit.rawIndex),
                          rawCount: hits.rawCount,
                        }),
                      ),
                    );
                  }),
                );
        const delivered = input.cursor?.delivered ?? 0;
        const perPage = Math.min(input.limit + 1, MAX_PAGE_SIZE);
        return listPage({
          fetch,
          state: input.state,
          limit: input.limit,
          cursor: input.cursor,
          page: Math.floor(delivered / perPage) + 1,
          collected: [],
          cursorAdvance: 0,
        });
      }),

    getPullRequest: (input) =>
      withRepository(input.repository, (path) => getPullRequest(path, input.number)),

    // The repository states what the credentials may do with it, so nothing beyond the one
    // read the detail was already making is needed.
    getRepositoryPermission: (input) =>
      withRepository(input.repository, (path) =>
        readPage({
          operation: "getRepositoryPermission",
          url: path,
          decode: decodeRepositoryPermissionJson,
        }),
      ),

    getPullRequestDiff: (input) =>
      input.commit !== undefined && !isCommitSha(input.commit)
        ? Effect.fail(new ForgejoDiffCommitError())
        : withRepository(input.repository, (path) =>
            // Already a unified patch, so it needs no decoding at all — only a bound, which a
            // diff of any size would otherwise ignore. A commit's own patch sits beside the pull
            // request's at `/git/commits/{sha}.diff` and reads the same way.
            forgejo
              .request({
                method: "GET",
                url:
                  input.commit === undefined
                    ? `${path}/pulls/${input.number}.diff`
                    : `${path}/git/commits/${input.commit}.diff`,
                maxBytes: DIFF_MAX_BYTES,
              })
              .pipe(
                Effect.map((response) => ({ patch: response.body, truncated: response.truncated })),
              ),
          ),

    getDiffStat: (input) =>
      withRepository(input.repository, (path) =>
        readPage({
          operation: "getDiffStat",
          url: `${path}/pulls/${input.number}`,
          decode: decodeDiffstatJson,
        }),
      ),

    getMergeability: (input) =>
      withRepository(input.repository, (path) =>
        getPullRequest(path, input.number).pipe(
          Effect.map((pullRequest) => pullRequest.mergeability),
        ),
      ),

    listComments: (input) =>
      withRepository(input.repository, (path) => listComments(path, input.number)),

    listCommits: (input) =>
      withRepository(input.repository, (path) =>
        itemPages({
          operation: "listCommits",
          url: `${path}/pulls/${input.number}/commits`,
          decode: decodeCommitsJson,
          page: 1,
          items: [],
          prepend: true,
        }).pipe(Effect.map((commits) => commits.items)),
      ),

    listChecks: (input) =>
      withRepository(input.repository, (path) =>
        (input.headSha === undefined
          ? getPullRequest(path, input.number).pipe(
              Effect.map((pullRequest) => pullRequest.headSha),
            )
          : Effect.succeed(input.headSha)
        ).pipe(
          Effect.flatMap((headSha) =>
            headSha === null || !isCommitSha(headSha)
              ? Effect.succeed([])
              : readPage({
                  operation: "listChecks",
                  url: `${path}/commits/${headSha}/status`,
                  decode: decodeStatusesJson,
                }),
          ),
        ),
      ),

    listReviewerCandidates: (input) =>
      withRepository(input.repository, (path) =>
        Effect.all(
          [
            getPullRequest(path, input.number),
            readPage({
              operation: "listReviewerCandidates",
              url: `${path}/collaborators?${query([
                ["limit", String(MAX_PAGE_SIZE)],
                ["page", "1"],
              ])}`,
              decode: decodeCollaboratorsJson,
            }),
          ],
          { concurrency: 2 },
        ).pipe(
          Effect.map(([pullRequest, collaborators]) => {
            const requested = new Set(pullRequest.reviewerIds);
            const author = pullRequest.author?.login;
            return {
              // The author is dropped rather than shown unusable: Forgejo refuses to make the
              // person who opened a pull request its reviewer.
              candidates: collaborators.items.flatMap((candidate) =>
                candidate.login === author
                  ? []
                  : [{ ...candidate, isRequested: requested.has(candidate.id) }],
              ),
              truncated: collaborators.rawCount >= MAX_PAGE_SIZE,
            };
          }),
        ),
      ),

    setReviewerRequest: (input) =>
      withRepository(input.repository, (path) =>
        forgejo
          .request({
            // The same collection is posted to and deleted from, as on GitHub.
            method: input.requested ? "POST" : "DELETE",
            url: `${path}/pulls/${input.number}/requested_reviewers`,
            body: JSON.stringify({ reviewers: input.reviewers.map((reviewer) => reviewer.id) }),
          })
          .pipe(Effect.asVoid),
      ),

    runAction: (input) =>
      withRepository(input.repository, (path) => {
        const pullRequest = `${path}/pulls/${input.number}`;
        // Only merge, close and reopen reach here: the provider declares the others
        // unsupported, so the surface never offers them.
        switch (input.action) {
          case "merge":
            return forgejo
              .request({
                method: "POST",
                url: `${pullRequest}/merge`,
                body: JSON.stringify({ Do: mergeStrategy(input.mergeMethod) }),
              })
              .pipe(Effect.asVoid);
          case "close":
          case "reopen":
            return forgejo
              .request({
                method: "PATCH",
                url: pullRequest,
                body: JSON.stringify({ state: input.action === "close" ? "closed" : "open" }),
              })
              .pipe(Effect.asVoid);
          default:
            return Effect.fail(new ForgejoActionUnsupportedError({ action: input.action }));
        }
      }),

    updateChangeRequest: (input) =>
      withRepository(input.repository, (path) =>
        // Only the words this call rewrites travel in the body: Forgejo's PATCH is a partial
        // update, so any field left out is left as it was.
        forgejo
          .request({
            method: "PATCH",
            url: `${path}/pulls/${input.number}`,
            body: JSON.stringify({
              ...(input.title === undefined ? {} : { title: input.title }),
              ...(input.body === undefined ? {} : { body: input.body }),
            }),
          })
          .pipe(Effect.asVoid),
      ),

    comment: (input) =>
      withRepository(input.repository, (path) => postComment(path, input.number, input.body)),

    updateComment: (input) =>
      withRepository(input.repository, (path) =>
        forgejo
          .request({
            // Forgejo keeps a pull request's remarks and its line comments in the one
            // collection, so this endpoint rewrites either kind.
            method: "PATCH",
            url: `${path}/issues/comments/${encodeURIComponent(input.commentId)}`,
            body: JSON.stringify({ body: input.body }),
          })
          .pipe(Effect.asVoid),
      ),

    // Forgejo takes a whole review in one request, line comments and verdict together, so a
    // review that fails is never left half-standing.
    submitReview: (input) =>
      withRepository(input.repository, (path) =>
        postReview(path, input.number, {
          event: reviewEvent(input.verdict),
          body: input.body,
          comments: input.comments.map((comment) => ({
            path: comment.path,
            body: comment.body,
            ...forgejoReviewPosition(comment.position),
          })),
        }),
      ),

    replyToComment: (input) =>
      withRepository(input.repository, (path) =>
        listConversation(path, input.number).pipe(
          Effect.flatMap((conversation) => {
            const thread = conversation.threads.find(
              (candidate) => candidate.id === input.commentId,
            );
            if (thread === undefined || thread.line === null) {
              return postComment(path, input.number, input.body);
            }
            return postReview(path, input.number, {
              event: "COMMENT",
              body: "",
              comments: [
                {
                  path: thread.path,
                  body: input.body,
                  ...(thread.side === "left"
                    ? { old_position: thread.line }
                    : { new_position: thread.line }),
                },
              ],
            });
          }),
        ),
      ),

    setReaction: (input) =>
      withRepository(input.repository, (path) =>
        forgejo
          .request({
            // A reaction is a sub-resource that is created and deleted, and the body names which.
            method: input.active ? "POST" : "DELETE",
            url:
              input.commentId === undefined
                ? `${path}/issues/${input.number}/reactions`
                : `${path}/issues/comments/${encodeURIComponent(input.commentId)}/reactions`,
            body: JSON.stringify({ content: forgejoReactionName(input.content) }),
          })
          .pipe(Effect.asVoid),
      ),
  });
});

export const layer = Layer.effect(ForgejoPullRequestApi, make);
