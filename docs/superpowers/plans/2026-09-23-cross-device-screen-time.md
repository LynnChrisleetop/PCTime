# Cross-device Screen Time Implementation Plan

> **For agentic workers:** Use subagent-driven-development to implement the independent server, Android, Windows, and UI work, with integration review by the primary agent.

**Goal:** A runnable Windows + Android screen-time app with accounts, device views, and merged application totals.

**Architecture:** Existing Electron tracker gains a separate device-only journal and cloud bridge. Native Android reads Usage Access events. A self-hosted Node service authenticates users and stores replacement daily snapshots in SQLite.

**Tech Stack:** React 18 / Electron 30 / TypeScript, Node 24 `node:sqlite`, Android Java (minimum API 26), Gradle / AGP / JDK 17.

**Spec:** `docs/superpowers/specs/2026-09-23-cross-device-screen-time.md`

## Global constraints

- Sum durations across devices; local calendar days and explicit sync timestamps.
- Keep PCTime branding and approved A palette.
- Never upload raw window titles; never store passwords in clients or plaintext session tokens on disk.
- Preserve local tracking and old data; WebDAV history must not become duplicate cloud usage.
- New work stays on `codex/cross-device-screen-time`.

## Task 1: Account and sync service

Files: `server/`, `tests/cloud-server.test.mjs`. REST interfaces and exact payloads are in the spec.

- [x] Build SQLite schema, scrypt password auth, expiring hashed sessions, bounded JSON requests, auth rate limiting, and ownership checks.
- [x] Implement transactional snapshot replacement and canonical source mapping.
- [x] Test two users, Windows + Android same apps, repeated snapshots, older revisions, invalid totals, persistence, and cross-user reads/writes. Expected: a 600,000 ms WeChat entry on each device yields 1,200,000 ms overall and in the merged WeChat row.
- [x] Add startup scripts and persistent-volume deployment example.

## Task 2: Android application

Files: `android/`, Android-specific build/verification scripts. Implement the REST contract directly.

- [x] Add Gradle project and native Java UI for permission setup, account login, dates, device filters, merged app breakdown, and manual sync.
- [x] Reconstruct foreground intervals with UsageStatsManager, screen-off exclusion and local-midnight splitting. Test with synthetic event fixtures.
- [x] Persist identity/revisions; store session using Android Keystore; upload daily snapshots through a background executor and JobScheduler.
- [x] Compile and package a debug APK with official toolchain. Record device-test limitations honestly.

## Task 3: Windows journal and bridge

Files: `electron/cloud*.ts`, `electron/usageTracker.ts`, `electron/main.ts`, `electron/preload.ts`, `src/vite-env.d.ts`, focused tests.

- [x] Capture future tracker intervals in a separate durable device journal. Recognize known applications and Bilibili browser titles locally.
- [x] Implement safeStorage session persistence and the exact `window.cloud` interface in the spec.
- [x] Serialize periodic/manual sync, retry failures, and prevent account-switch responses from leaking state.
- [x] Test source canonicalization, no title uploads, no WebDAV duplication, restart persistence, logout and failed sync.

## Task 4: Shared types and React UI

Files: `src/lib/cloud.ts`, `src/components/CloudPanel.tsx`, `src/components/CloudPanel.css`, `src/App.tsx`, docs.

- [x] Add a cross-device navigation view with account setup, connection state, day selection, device totals, and expandable merged app rows.
- [x] Add honest demo data and an in-memory browser viewer; no fake collecting device.
- [x] Preserve local navigation and responsive layout, keyboard labels, status/error states, and reduced motion.
- [x] Validate server-to-client contract end to end, lint/typecheck/tests, inspect UI, build Windows ZIP, and provide install/run guide.
