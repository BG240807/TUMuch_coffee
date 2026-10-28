# Scenario Comparison Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Compare the unedited city with the current proposal without changing editor logic.

**Architecture:** A new card consumes existing live arrays through one initialization line.
A separate vector layer provides original buildings without mutating deletion state.

**Tech Stack:** Native JavaScript modules, CSS, browser integration tests.

**Spec:** `docs/superpowers/specs/2026-10-28-scenario-comparison-design.md`

## Global Constraints

- Only one added integration line in existing code; all other changes are new files.
- English comments and UI; no new runtime dependencies or existing logic changes.
- Baseline viewing never saves, deletes, or overwrites the proposal.
- Canopy is a sum of circular areas, including overlap, not coverage or cooling.

## Review Focus

- Reloaded sessions retain proposed changes while the baseline remains unedited.
- Original mode blocks map and keyboard editing and preserves camera navigation.
- Original buildings remain visible as vector tiles load during navigation.
- An in-flight tree import remains hidden in Original and appears in Proposal.
- Small screens retain access to existing toolbar and the comparison controls.

### Task 1: Comparison card and browser checks

**Files:** Create `comparison-card.js`, `comparison-card.css`,
`tests/comparison.test.mjs`; add one line in `index.html`.

**Interfaces:** `addComparisonCard({ map, scene, placed, deleted })` consumes the existing
map, Three.js scene and live arrays. It creates its own card and original-building layer.

- [x] Write browser tests for zero changes, mixed edits and canopy arithmetic,
  undo/restore, session reload, switching without storage changes, original-mode
  editing protection, navigation, delayed imports, and narrow viewports.
- [x] Run the tests before implementation and confirm missing comparison UI fails.
- [x] Implement the card and one-line integration, preserving editor logic.
- [x] Run the complete browser suite and inspect desktop/mobile screenshots.
- [ ] Review the final diff, commit, push the feature branch and open a PR to `main`.

Validation: 11/11 browser checks pass. Independent static review found one import
visibility flash; its render-frame regression failed before the fix and passes after.
