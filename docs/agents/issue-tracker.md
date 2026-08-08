# Issue Tracker: GitHub

Issues and PRDs for this repository live in GitHub Issues at `rysaio/autopro`.
Use the `gh` CLI from the repository root for issue operations.

## Conventions

- Create an issue with `gh issue create`.
- Read an issue and its comments with `gh issue view <number> --comments`.
- List issues with `gh issue list` and request JSON output when filtering or summarizing.
- Comment with `gh issue comment <number>`.
- Apply or remove labels with `gh issue edit <number>`.
- Close an issue with `gh issue close <number>` and include a reason when useful.

When a skill says to publish to the issue tracker, create a GitHub issue in `rysaio/autopro`.
Infer repository context from the current clone unless an explicit `--repo` is safer.
