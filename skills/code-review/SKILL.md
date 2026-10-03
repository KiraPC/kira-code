---
name: code-review
description: Reviews a change for correctness bugs and cleanups before it is committed. Use when the user asks for a review, or before proposing a commit.
version: 1.0.0
tags:
  - development
  - review
---

# Code review

Review the pending change, not the whole codebase.

## How to scope the review

1. Run `git diff` (and `git diff --staged`) to see what actually changed.
2. Read enough surrounding code to judge each hunk in context — a diff alone hides the caller.
3. Ignore pre-existing issues outside the change unless they are the reason the change is broken.

## What to look for

Correctness first:

- Off-by-one errors, wrong comparison operators, inverted conditions
- Unhandled error paths and rejected promises
- Values that can be `null`/`undefined` at runtime but are treated as present
- Behaviour changes that break existing callers
- Missing `await` on async calls

Then quality:

- Logic duplicated from something that already exists in the repo
- Code that is more general than the problem requires
- Tests that assert nothing meaningful, or a missing test for the bug being fixed

## How to report

For each finding: `path/to/file.ts:42` — what is wrong, and the concrete input or state that makes it fail.

Rank the findings by severity, most severe first. Say plainly when the change looks correct — do not invent findings to fill the list.
