---
type: Reference
title: Domain Documentation
description: Rules for consuming mcpx domain language and architectural decisions.
---

# Domain Documentation

This repository uses a single domain context.

## Before Exploring

Read:

- `/CONTEXT.md`, when present.
- Relevant ADRs under `/docs/adr/`.

Missing files are not errors. `/domain-modeling` creates them lazily when terminology or durable decisions are resolved.

## Vocabulary

Use terms exactly as defined in `CONTEXT.md`. Do not introduce synonyms for established concepts.

If a required concept is absent, either reconsider the new term or record the gap through `/domain-modeling`.

## Architectural Decisions

Surface conflicts with existing ADRs explicitly. Do not silently override an accepted decision.
