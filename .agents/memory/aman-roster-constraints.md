---
name: Aman roster constraints
description: User-provided scheduling, language, and demo-data constraints for Aman Team Shifts.
---

- Use the Asia/Qatar timezone and start calendar weeks on Sunday.
- Keep the interface English-first and ready for right-to-left layout.
- Use fictional demonstration roster data only; treat the attached schedule image as a visual reference, not as seed data.

**Why:** These constraints were included in the app brief and help prevent timezone errors and copying staff details from the reference.

**How to apply:** Keep calendar and date behavior consistent, preserve RTL support, and never seed names or records taken from the reference image.

- The ED-ICU workbook has merged legend rows after staff rows and one staff row without an ID or role; distinguish staff rows using identity/role evidence or multiple recognized shift cells, not worksheet bounds alone.

**Why:** Non-roster formatted rows can resemble staff rows, while the missing-ID employee still has valid assignments that must not be dropped.

**How to apply:** Keep the workbook as a regression fixture; keep row-range assumptions out of general parser logic.

- Team Shifts defaults to All Staff; blank source cells display as OFF, while `/` remains a distinct unresolved, non-working status.

**Why:** The latest roster verification requirements explicitly distinguish `/` from OFF while preserving the original workbook value.

**How to apply:** Keep all attendance statuses visible, exclude them from working counts, retain raw workbook values, and do not convert `/` to OFF unless the user later changes this rule.

- Synthetic identities are permitted only in isolated staging integration tests; keep application role checks enabled and never bypass Production authentication.

**Why:** The user explicitly authorized synthetic test identities for staging only and required real Clerk sessions to remain clearly untested.

**How to apply:** Route test writes exclusively through `STAGING_DATABASE_URL`, resolve synthetic roles server-side, and do not claim Clerk or physical-device tests passed unless actually performed.
