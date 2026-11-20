---
name: Workspace TypeScript rebuilds
description: Refresh composite library declarations after shared dependency upgrades.
---

After upgrading a shared catalog dependency, force-rebuild composite library declarations with `pnpm exec tsc --build --force` before diagnosing downstream artifact type errors. Incremental builds can reuse declarations generated against the previous dependency version; the normal root typecheck remains the final check.

**Why:** In this workspace, a Zod major-version update initially produced widespread errors in the Excel import handler, but a forced declaration rebuild cleared them without changes to import behavior.

**How to apply:** Use this when a type error appears after a workspace dependency upgrade and the source is otherwise unchanged; rebuild library declarations first, then run the root typecheck.
