# Domain Docs

This repository uses a single-context domain documentation layout.

## Before Exploring

- Read `CONTEXT.md` at the repository root when it exists.
- Read relevant ADRs under `docs/adr/` when that directory exists.
- If either location is absent, continue without creating placeholder documentation.
- We use DOCs just under `docs/` to replace ADRs in this repo. 
- `docs/notes/` is for per-DOCs' drafts and not prepared for complement.

## Vocabulary

Use the domain terms defined in `CONTEXT.md` in issues, PRDs, tests, and implementation notes.
Do not introduce synonyms that conflict with the glossary. If a necessary concept is missing, record the gap for later domain clarification.

## Architectural Decisions

Surface any conflict with an existing DOCs explicitly. Do not silently override a documented decision.
