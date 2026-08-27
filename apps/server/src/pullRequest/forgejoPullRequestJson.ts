import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  PullRequestActor,
  PullRequestCheck,
  PullRequestCheckStatus,
  PullRequestComment,
  PullRequestCommit,
  PullRequestLabel,
  PullRequestMergeability,
  PullRequestReviewThread,
  PullRequestReviewerCandidate,
  PullRequestState,
} from "@t3tools/contracts";
import { TrimmedNonEmptyString } from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

import { dedupeChecks } from "./pullRequestChecks.ts";

/**
 * Forgejo's enums are decoded as plain strings and normalized here, in the same tolerant style
 * as the GitHub and GitLab decoders: a new review state or commit status must not fail a whole
 * payload.
 */
const RawUserSchema = Schema.Struct({
  /** How Forgejo addresses an account everywhere, reviewer requests included. */
  login: Schema.optional(Schema.NullOr(Schema.String)),
  full_name: Schema.optional(Schema.NullOr(Schema.String)),
  avatar_url: Schema.optional(Schema.NullOr(Schema.String)),
});

/**
 * Required, and required to be non-empty: the wire contract will not carry a change request
 * without a branch or a link, so a row missing one is skipped rather than breaking the response
 * it travels in.
 */
const RawBranchSchema = Schema.Struct({
  ref: TrimmedNonEmptyString,
  sha: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawLabelSchema = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
  color: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawPullRequestSchema = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  /** `open` or `closed`; a merged pull request is a closed one with `merged` set. */
  state: Schema.optional(Schema.NullOr(Schema.String)),
  merged: Schema.optional(Schema.NullOr(Schema.Boolean)),
  draft: Schema.optional(Schema.NullOr(Schema.Boolean)),
  /** Null while Forgejo has not worked it out yet. */
  mergeable: Schema.optional(Schema.NullOr(Schema.Boolean)),
  user: Schema.optional(Schema.NullOr(RawUserSchema)),
  head: RawBranchSchema,
  base: RawBranchSchema,
  created_at: Schema.String,
  updated_at: Schema.String,
  merged_at: Schema.optional(Schema.NullOr(Schema.String)),
  closed_at: Schema.optional(Schema.NullOr(Schema.String)),
  requested_reviewers: Schema.optional(Schema.NullOr(Schema.Array(Schema.NullOr(RawUserSchema)))),
  labels: Schema.optional(Schema.NullOr(Schema.Array(RawLabelSchema))),
  additions: Schema.optional(Schema.NullOr(Schema.Int)),
  deletions: Schema.optional(Schema.NullOr(Schema.Int)),
  changed_files: Schema.optional(Schema.NullOr(Schema.Int)),
  html_url: TrimmedNonEmptyString,
});

/** Forgejo pages every list as a bare array; the page number lives in the request alone. */
const RawListSchema = Schema.Array(Schema.Unknown);

/** One row of `/issues/{index}/comments`, which only ever holds the plain remarks. */
const RawCommentSchema = Schema.Struct({
  id: Schema.Int,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.optional(Schema.NullOr(RawUserSchema)),
  created_at: Schema.String,
  html_url: Schema.optional(Schema.NullOr(Schema.String)),
});

/** One row of `/pulls/{index}/reviews`. */
const RawReviewSchema = Schema.Struct({
  id: Schema.Int,
  /** `APPROVED`, `REQUEST_CHANGES`, `COMMENT`, or `PENDING` while still being written. */
  state: Schema.optional(Schema.NullOr(Schema.String)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.optional(Schema.NullOr(RawUserSchema)),
  submitted_at: Schema.optional(Schema.NullOr(Schema.String)),
  html_url: Schema.optional(Schema.NullOr(Schema.String)),
  /** How many line comments the review carries, which decides whether its comments are read. */
  comments_count: Schema.optional(Schema.NullOr(Schema.Int)),
});

/** One row of `/pulls/{index}/reviews/{id}/comments`. */
const RawReviewCommentSchema = Schema.Struct({
  id: Schema.Int,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  path: Schema.optional(Schema.NullOr(Schema.String)),
  /** The line in the file as it is now; zero when the comment sits on a removed line. */
  position: Schema.optional(Schema.NullOr(Schema.Int)),
  /** The line in the file as it was; zero when the comment sits on an added line. */
  original_position: Schema.optional(Schema.NullOr(Schema.Int)),
  user: Schema.optional(Schema.NullOr(RawUserSchema)),
  /** Whoever marked the conversation resolved, which Forgejo reports but lets nobody set by API. */
  resolver: Schema.optional(Schema.NullOr(RawUserSchema)),
  created_at: Schema.String,
  html_url: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawCommitSchema = Schema.Struct({
  sha: TrimmedNonEmptyString,
  commit: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        message: Schema.optional(Schema.NullOr(Schema.String)),
        author: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              name: Schema.optional(Schema.NullOr(Schema.String)),
              date: Schema.optional(Schema.NullOr(Schema.String)),
            }),
          ),
        ),
      }),
    ),
  ),
  /** The account behind the commit, where Forgejo could match the author to one. */
  author: Schema.optional(Schema.NullOr(RawUserSchema)),
});

/** `/commits/{sha}/status`: one combined answer wrapping every status the commit carries. */
const RawCombinedStatusSchema = Schema.Struct({
  statuses: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          context: Schema.optional(Schema.NullOr(Schema.String)),
          status: Schema.optional(Schema.NullOr(Schema.String)),
          description: Schema.optional(Schema.NullOr(Schema.String)),
          target_url: Schema.optional(Schema.NullOr(Schema.String)),
          updated_at: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  ),
});

/** One row of `/repos/{owner}/{repo}/collaborators`, which is an account outright. */
const RawCollaboratorSchema = RawUserSchema;

const RawViewerSchema = Schema.Struct({
  login: Schema.optional(Schema.NullOr(Schema.String)),
  full_name: Schema.optional(Schema.NullOr(Schema.String)),
});

/**
 * The repository itself carries what the credentials may do with it, so no separate read is
 * needed: `push` is what merging takes.
 */
const RawRepositoryPermissionsSchema = Schema.Struct({
  permissions: Schema.optional(
    Schema.NullOr(Schema.Struct({ push: Schema.optional(Schema.NullOr(Schema.Boolean)) })),
  ),
});

export interface ForgejoPullRequest {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: PullRequestActor | null;
  readonly headBranch: string;
  readonly baseBranch: string;
  /** The commit the checks are reported against. Null where Forgejo left it out. */
  readonly headSha: string | null;
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  /** From the pull request's own `mergeable`, which Forgejo reports on list and detail alike. */
  readonly mergeability: PullRequestMergeability;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly mergedAt: string | null;
  readonly closedAt: string | null;
  readonly body: string;
  readonly reviewRequestLogins: ReadonlyArray<string>;
  readonly reviewers: ReadonlyArray<PullRequestActor>;
  /** The reviewers as Forgejo addresses them, which is their logins. */
  readonly reviewerIds: ReadonlyArray<string>;
  readonly labels: ReadonlyArray<PullRequestLabel>;
}

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : null;
}

/**
 * Forgejo stamps times in the server's own offset. The page sorts change requests from every host
 * against each other as plain strings, so they are normalized to the same `Z` form the other hosts
 * already use.
 */
function toIsoUtc(value: string): string {
  return Option.match(DateTime.make(value), {
    onNone: () => value,
    onSome: DateTime.formatIso,
  });
}

function toIsoUtcOrNull(value: string | null | undefined): string | null {
  const text = trimmed(value);
  return text === null ? null : toIsoUtc(text);
}

function toActor(raw: Schema.Schema.Type<typeof RawUserSchema> | null | undefined) {
  const login = trimmed(raw?.login);
  return login === null
    ? null
    : {
        login,
        name: trimmed(raw?.full_name),
        avatarUrl: trimmed(raw?.avatar_url),
      };
}

/** Forgejo knows only open and closed; merged is a closed pull request with `merged` set. */
function toState(raw: Schema.Schema.Type<typeof RawPullRequestSchema>): PullRequestState {
  if (raw.merged === true) return "merged";
  return raw.state?.trim().toLowerCase() === "closed" ? "closed" : "open";
}

function toMergeability(mergeable: boolean | null | undefined): PullRequestMergeability {
  if (mergeable === true) return "mergeable";
  if (mergeable === false) return "conflicting";
  return "unknown";
}

function toCheckStatus(value: string | null | undefined): PullRequestCheckStatus {
  switch (value?.trim().toLowerCase()) {
    case "success":
      return "success";
    case "failure":
    case "error":
      return "failure";
    case "pending":
      return "pending";
    default:
      return "neutral";
  }
}

/**
 * Forgejo's review states, spelled the way GitHub spells them, which is what the page already
 * reads a verdict from. Anything else travels as it arrived.
 */
function toReviewState(value: string | null | undefined): string | null {
  const state = trimmed(value);
  switch (state?.toUpperCase()) {
    case "APPROVED":
      return "APPROVED";
    case "REQUEST_CHANGES":
      return "CHANGES_REQUESTED";
    case "COMMENT":
      return "COMMENTED";
    default:
      return state;
  }
}

function toPullRequest(raw: Schema.Schema.Type<typeof RawPullRequestSchema>): ForgejoPullRequest {
  const reviewers = (raw.requested_reviewers ?? []).flatMap((reviewer) => {
    const actor = toActor(reviewer);
    return actor === null ? [] : [actor];
  });
  return {
    number: raw.number,
    title: raw.title,
    url: raw.html_url,
    author: toActor(raw.user),
    headBranch: raw.head.ref,
    baseBranch: raw.base.ref,
    headSha: trimmed(raw.head.sha),
    state: toState(raw),
    isDraft: raw.draft ?? false,
    mergeability: toMergeability(raw.mergeable),
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    changedFiles: raw.changed_files ?? 0,
    createdAt: toIsoUtc(raw.created_at),
    updatedAt: toIsoUtc(raw.updated_at),
    mergedAt: toIsoUtcOrNull(raw.merged_at),
    closedAt: toIsoUtcOrNull(raw.closed_at),
    body: raw.body ?? "",
    reviewRequestLogins: reviewers.map((reviewer) => reviewer.login),
    reviewers,
    reviewerIds: reviewers.map((reviewer) => reviewer.login),
    labels: (raw.labels ?? []).flatMap((label) => {
      const name = trimmed(label.name);
      return name === null ? [] : [{ name, color: trimmed(label.color) }];
    }),
  };
}

const decodeList = decodeJsonResult(RawListSchema);
const decodePullRequestEntry = Schema.decodeUnknownExit(RawPullRequestSchema);
const decodePullRequest = decodeJsonResult(RawPullRequestSchema);
const decodeCommentEntry = Schema.decodeUnknownExit(RawCommentSchema);
const decodeReviewEntry = Schema.decodeUnknownExit(RawReviewSchema);
const decodeReviewCommentEntry = Schema.decodeUnknownExit(RawReviewCommentSchema);
const decodeCommitEntry = Schema.decodeUnknownExit(RawCommitSchema);
const decodeCombinedStatus = decodeJsonResult(RawCombinedStatusSchema);
const decodeCollaboratorEntry = Schema.decodeUnknownExit(RawCollaboratorSchema);
const decodeViewer = decodeJsonResult(RawViewerSchema);
const decodeRepositoryPermissions = decodeJsonResult(RawRepositoryPermissionsSchema);

type DecodeFailure = Cause.Cause<Schema.SchemaError>;

export interface ForgejoPage<A> {
  readonly items: ReadonlyArray<A>;
  /** Rows Forgejo returned, counted before decoding, so a skipped row cannot hide a next page. */
  readonly rawCount: number;
}

export interface ForgejoPullRequestPage extends ForgejoPage<ForgejoPullRequest> {
  /** Zero-based positions of the decoded items in Forgejo's raw page. */
  readonly rawIndexes: ReadonlyArray<number>;
}

/** Malformed entries are skipped rather than failing the page, as on the other hosts. */
export function decodePullRequestPageJson(
  raw: string,
): Result.Result<ForgejoPullRequestPage, DecodeFailure> {
  const decoded = decodeList(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const items: ForgejoPullRequest[] = [];
  const rawIndexes: number[] = [];
  for (const [rawIndex, entry] of decoded.success.entries()) {
    const item = decodePullRequestEntry(entry);
    if (Exit.isSuccess(item)) {
      items.push(toPullRequest(item.value));
      rawIndexes.push(rawIndex);
    }
  }
  return Result.succeed({ items, rawIndexes, rawCount: decoded.success.length });
}

export function decodePullRequestJson(
  raw: string,
): Result.Result<ForgejoPullRequest, DecodeFailure> {
  const decoded = decodePullRequest(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(toPullRequest(decoded.success))
    : Result.fail(decoded.failure);
}

export function decodeViewerJson(raw: string): Result.Result<string | null, DecodeFailure> {
  const decoded = decodeViewer(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(trimmed(decoded.success.login) ?? trimmed(decoded.success.full_name))
    : Result.fail(decoded.failure);
}

/**
 * Whether the configured credentials can write to the repository, which is what merging needs.
 * Read off the repository itself, whose `permissions.push` is the account's own standing. A
 * repository that names no permissions at all is an unknown standing, which is granted rather
 * than guessed away.
 */
export function decodeRepositoryPermissionJson(raw: string): Result.Result<boolean, DecodeFailure> {
  const decoded = decodeRepositoryPermissions(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const push = decoded.success.permissions?.push;
  return Result.succeed(push === null || push === undefined ? true : push);
}

/**
 * The repository's collaborators, which is who Forgejo lets a review be asked of. Nobody is
 * marked requested here: who has been asked lives on the pull request, and only the caller holds
 * both.
 */
export function decodeCollaboratorsJson(
  raw: string,
): Result.Result<ForgejoPage<PullRequestReviewerCandidate>, DecodeFailure> {
  const decoded = decodeList(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const items: PullRequestReviewerCandidate[] = [];
  for (const entry of decoded.success) {
    const collaborator = decodeCollaboratorEntry(entry);
    if (Exit.isFailure(collaborator)) continue;
    const actor = toActor(collaborator.value);
    if (actor === null) continue;
    items.push({ ...actor, id: actor.login, kind: "user", isRequested: false });
  }
  return Result.succeed({ items, rawCount: decoded.success.length });
}

/** Deleted comments carry nothing to show, and Forgejo already leaves them out. */
export function decodeCommentsJson(
  raw: string,
): Result.Result<ForgejoPage<PullRequestComment>, DecodeFailure> {
  const decoded = decodeList(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const items: PullRequestComment[] = [];
  for (const entry of decoded.success) {
    const decodedComment = decodeCommentEntry(entry);
    if (Exit.isFailure(decodedComment)) continue;
    const comment = decodedComment.value;
    const body = comment.body ?? "";
    if (body.trim().length === 0) continue;
    items.push({
      id: String(comment.id),
      kind: "issue-comment",
      author: toActor(comment.user),
      body,
      createdAt: toIsoUtc(comment.created_at),
      url: trimmed(comment.html_url),
      path: null,
      reviewState: null,
    });
  }
  return Result.succeed({ items, rawCount: decoded.success.length });
}

export interface ForgejoReview {
  /** The review as a row of the conversation, or null for one with nothing to say on its own. */
  readonly comment: PullRequestComment | null;
  /** The review's id, for the line comments that hang off it. */
  readonly id: number;
  /** Whether Forgejo reports any line comments on it, which is what makes them worth reading. */
  readonly hasComments: boolean;
}

/**
 * A review with no body is kept only when its state is the event itself — an approval or a
 * request for changes. Forgejo also opens a bodiless `COMMENT` review as the container for line
 * comments, and those are read from the review's own comments, so keeping the container too
 * would show a row with a name and nothing under it. A `PENDING` review is one still being
 * written, and is nobody else's to see.
 */
export function decodeReviewsJson(
  raw: string,
): Result.Result<ForgejoPage<ForgejoReview>, DecodeFailure> {
  const decoded = decodeList(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const items: ForgejoReview[] = [];
  for (const entry of decoded.success) {
    const decodedReview = decodeReviewEntry(entry);
    if (Exit.isFailure(decodedReview)) continue;
    const review = decodedReview.value;
    const state = trimmed(review.state)?.toUpperCase() ?? null;
    if (state === "PENDING") continue;
    const submittedAt = trimmed(review.submitted_at);
    const body = review.body ?? "";
    const isVerdict = state === "APPROVED" || state === "REQUEST_CHANGES";
    const comment: PullRequestComment | null =
      submittedAt === null || (body.trim().length === 0 && !isVerdict)
        ? null
        : {
            id: String(review.id),
            kind: "review",
            author: toActor(review.user),
            body,
            createdAt: toIsoUtc(submittedAt),
            url: trimmed(review.html_url),
            path: null,
            reviewState: toReviewState(review.state),
          };
    items.push({ comment, id: review.id, hasComments: (review.comments_count ?? 0) > 0 });
  }
  return Result.succeed({ items, rawCount: decoded.success.length });
}

/** One line comment as Forgejo sent it, kept so threads can be assembled across reviews. */
export type ForgejoRawReviewComment = Schema.Schema.Type<typeof RawReviewCommentSchema>;

export interface ForgejoReviewComments {
  readonly comments: ReadonlyArray<PullRequestComment>;
  /**
   * The same comments unread, for `buildReviewThreads`. Two remarks on one line can come from
   * two different reviews, and only the caller holding every review can put them together.
   */
  readonly entries: ReadonlyArray<ForgejoRawReviewComment>;
}

/** A comment pinned to a file is a line-level review comment, which is what that kind means. */
export function decodeReviewCommentsJson(
  raw: string,
): Result.Result<ForgejoReviewComments, DecodeFailure> {
  const decoded = decodeList(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const comments: PullRequestComment[] = [];
  const entries: ForgejoRawReviewComment[] = [];
  for (const entry of decoded.success) {
    const decodedComment = decodeReviewCommentEntry(entry);
    if (Exit.isFailure(decodedComment)) continue;
    const comment = decodedComment.value;
    const body = comment.body ?? "";
    if (body.trim().length === 0) continue;
    entries.push(comment);
    comments.push({
      id: String(comment.id),
      kind: "review-comment",
      author: toActor(comment.user),
      body,
      createdAt: toIsoUtc(comment.created_at),
      url: trimmed(comment.html_url),
      path: trimmed(comment.path),
      reviewState: null,
    });
  }
  return Result.succeed({ comments, entries });
}

/** Where a line comment sits in the diff, as the thread it belongs to is keyed. */
export interface ForgejoThreadAnchor {
  readonly path: string;
  readonly side: "left" | "right";
  readonly line: number | null;
}

/**
 * The line a comment is pinned to. `position` is the line as the file stands now, and
 * `original_position` the line it replaced; a comment that carries only the latter was written
 * against the removed side. Forgejo writes zero rather than null for the side a comment is not on.
 */
export function reviewCommentAnchor(comment: ForgejoRawReviewComment): ForgejoThreadAnchor | null {
  const path = trimmed(comment.path);
  if (path === null) return null;
  const position = comment.position ?? 0;
  const originalPosition = comment.original_position ?? 0;
  const side = position > 0 || originalPosition <= 0 ? "right" : "left";
  const line = side === "right" ? position : originalPosition;
  return { path, side, line: line > 0 ? line : null };
}

/**
 * Forgejo has no thread of its own: every review comment stands alone, and two remarks on the
 * same line of the same file are the same conversation only by where they sit. A thread is thus
 * assembled from the line comments of every review, grouped by file, side and line, and named
 * after its oldest comment — which is the id a reply is later addressed to.
 */
export function buildReviewThreads(
  comments: ReadonlyArray<ForgejoRawReviewComment>,
): ReadonlyArray<PullRequestReviewThread> {
  const groups = new Map<
    string,
    { readonly anchor: ForgejoThreadAnchor; readonly entries: Array<ForgejoRawReviewComment> }
  >();
  for (const comment of comments) {
    const anchor = reviewCommentAnchor(comment);
    if (anchor === null) continue;
    const key = `${anchor.path} ${anchor.side} ${anchor.line ?? ""}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { anchor, entries: [comment] });
    else group.entries.push(comment);
  }

  return [...groups.values()].flatMap((group) => {
    const entries = group.entries.toSorted((left, right) =>
      left.created_at.localeCompare(right.created_at),
    );
    const root = entries[0];
    if (root === undefined) return [];
    return [
      {
        id: String(root.id),
        path: group.anchor.path,
        line: group.anchor.line,
        side: group.anchor.side,
        // Forgejo reports who resolved a conversation but takes no resolution over the API, so
        // this is read and never written.
        isResolved: entries.every(
          (entry) => entry.resolver !== null && entry.resolver !== undefined,
        ),
        isOutdated: false,
        comments: entries.map((comment) => ({
          id: String(comment.id),
          author: toActor(comment.user),
          body: comment.body ?? "",
          createdAt: toIsoUtc(comment.created_at),
          url: trimmed(comment.html_url),
        })),
      },
    ];
  });
}

export function decodeCommitsJson(
  raw: string,
): Result.Result<ForgejoPage<PullRequestCommit>, DecodeFailure> {
  const decoded = decodeList(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const commits: PullRequestCommit[] = [];
  for (const entry of decoded.success) {
    const decodedCommit = decodeCommitEntry(entry);
    if (Exit.isFailure(decodedCommit)) continue;
    const commit = decodedCommit.value;
    const committedDate = trimmed(commit.commit?.author?.date);
    if (committedDate === null) continue;
    const linkedAuthor = toActor(commit.author);
    const rawAuthor = trimmed(commit.commit?.author?.name);
    commits.push({
      oid: commit.sha,
      messageHeadline: (commit.commit?.message ?? "").split("\n")[0] ?? "",
      committedDate: toIsoUtc(committedDate),
      authors:
        linkedAuthor !== null
          ? [linkedAuthor]
          : rawAuthor === null
            ? []
            : [{ login: rawAuthor, name: rawAuthor, avatarUrl: null }],
    });
  }
  // Forgejo lists a pull request's commits newest first; the timeline reads oldest first.
  return Result.succeed({ items: commits.toReversed(), rawCount: decoded.success.length });
}

/**
 * The commit's combined status, one entry per context. Forgejo keeps every status ever posted
 * under a context, so the same check can appear more than once; the newest one wins.
 */
export function decodeStatusesJson(
  raw: string,
): Result.Result<ReadonlyArray<PullRequestCheck>, DecodeFailure> {
  const decoded = decodeCombinedStatus(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const checks: Array<{
    readonly check: PullRequestCheck;
    readonly workflowName: string | null;
    readonly at: string | null;
  }> = [];
  for (const status of decoded.success.statuses ?? []) {
    const name = trimmed(status.context);
    if (name === null) continue;
    checks.push({
      check: {
        name,
        status: toCheckStatus(status.status),
        description: trimmed(status.description),
        url: trimmed(status.target_url),
      },
      workflowName: null,
      at: toIsoUtcOrNull(status.updated_at),
    });
  }
  return Result.succeed(dedupeChecks(checks));
}

export interface ForgejoDiffStat {
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
}

/** The line counts ride on the pull request itself, so this reads them off that same document. */
export function decodeDiffstatJson(raw: string): Result.Result<ForgejoDiffStat, DecodeFailure> {
  const decoded = decodePullRequest(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  return Result.succeed({
    additions: decoded.success.additions ?? 0,
    deletions: decoded.success.deletions ?? 0,
    changedFiles: decoded.success.changed_files ?? 0,
  });
}

/**
 * One hit of `/repos/issues/search?type=pulls`, which answers with issues rather than pull
 * requests: the number and the repository it lives in are all that is read, and the pull request
 * itself is fetched afterwards.
 */
const RawSearchHitSchema = Schema.Struct({
  number: Schema.Int,
  repository: Schema.optional(
    Schema.NullOr(Schema.Struct({ full_name: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
});

const decodeSearchHitEntry = Schema.decodeUnknownExit(RawSearchHitSchema);

export interface ForgejoSearchHit {
  readonly number: number;
  /** `owner/repo`, or null where the hit named none. */
  readonly repository: string | null;
}

export interface ForgejoSearchPage extends ForgejoPage<ForgejoSearchHit> {
  /** Zero-based positions of the decoded hits in Forgejo's raw page. */
  readonly rawIndexes: ReadonlyArray<number>;
}

export function decodeSearchJson(raw: string): Result.Result<ForgejoSearchPage, DecodeFailure> {
  const decoded = decodeList(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const items: ForgejoSearchHit[] = [];
  const rawIndexes: number[] = [];
  for (const [rawIndex, entry] of decoded.success.entries()) {
    const hit = decodeSearchHitEntry(entry);
    if (Exit.isFailure(hit)) continue;
    items.push({ number: hit.value.number, repository: trimmed(hit.value.repository?.full_name) });
    rawIndexes.push(rawIndex);
  }
  return Result.succeed({ items, rawIndexes, rawCount: decoded.success.length });
}
