import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { PositiveInt, TrimmedNonEmptyString } from "@t3tools/contracts";

export interface NormalizedForgejoPullRequestRecord {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state: "open" | "closed" | "merged";
  readonly updatedAt: Option.Option<DateTime.Utc>;
  readonly isCrossRepository?: boolean;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly headRepositoryOwnerLogin?: string | null;
}

export const ForgejoRepositoryRefSchema = Schema.Struct({
  full_name: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  owner: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        login: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
      }),
    ),
  ),
});

export const ForgejoPullRequestBranchSchema = Schema.Struct({
  ref: TrimmedNonEmptyString,
  repo: Schema.optional(Schema.NullOr(ForgejoRepositoryRefSchema)),
});

/** One pull request as Forgejo reports it; the list and detail endpoints share this shape. */
export const ForgejoPullRequestSchema = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  /** "open" or "closed"; a merged pull request is "closed" with `merged` set. */
  state: Schema.optional(Schema.NullOr(Schema.String)),
  merged: Schema.optional(Schema.NullOr(Schema.Boolean)),
  updated_at: Schema.optional(Schema.OptionFromNullOr(Schema.DateTimeUtcFromString)),
  html_url: TrimmedNonEmptyString,
  head: ForgejoPullRequestBranchSchema,
  base: ForgejoPullRequestBranchSchema,
});

export const ForgejoPullRequestListSchema = Schema.Array(ForgejoPullRequestSchema);

function trimOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function repositoryOwner(repository: Schema.Schema.Type<typeof ForgejoRepositoryRefSchema>) {
  return (
    trimOptionalString(repository.owner?.login) ??
    (repository.full_name?.includes("/") ? (repository.full_name.split("/")[0] ?? null) : null)
  );
}

function normalizeForgejoPullRequestState(input: {
  readonly state?: string | null | undefined;
  readonly merged?: boolean | null | undefined;
}) {
  if (input.merged === true) return "merged" as const;
  return input.state?.trim().toLowerCase() === "closed" ? ("closed" as const) : ("open" as const);
}

export function normalizeForgejoPullRequestRecord(
  raw: Schema.Schema.Type<typeof ForgejoPullRequestSchema>,
): NormalizedForgejoPullRequestRecord {
  const headRepositoryNameWithOwner = trimOptionalString(raw.head.repo?.full_name);
  const baseRepositoryNameWithOwner = trimOptionalString(raw.base.repo?.full_name);
  const headRepositoryOwnerLogin = raw.head.repo ? repositoryOwner(raw.head.repo) : null;
  const isCrossRepository =
    headRepositoryNameWithOwner !== null &&
    baseRepositoryNameWithOwner !== null &&
    headRepositoryNameWithOwner !== baseRepositoryNameWithOwner;

  return {
    number: raw.number,
    title: raw.title,
    url: raw.html_url,
    baseRefName: raw.base.ref,
    headRefName: raw.head.ref,
    state: normalizeForgejoPullRequestState(raw),
    updatedAt: raw.updated_at ?? Option.none(),
    ...(isCrossRepository ? { isCrossRepository: true } : {}),
    ...(headRepositoryNameWithOwner ? { headRepositoryNameWithOwner } : {}),
    ...(headRepositoryOwnerLogin ? { headRepositoryOwnerLogin } : {}),
  };
}
