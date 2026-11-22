---
name: Clerk with separate frontend and API hosts
description: The Aman PWA uses Cloudflare Pages with a separate Node API, so Clerk's Frontend API proxy needs same-domain forwarding.
---

For Aman Team Shifts on Cloudflare Pages with an API hosted on another origin, serve the Clerk Frontend API proxy path from the public application domain and forward it server-side to the API host. Preserve the public application host and HTTPS scheme in forwarded headers so the API's Clerk proxy constructs the Clerk proxy URL for the app's domain. Keep normal roster API calls protected by exact-origin CORS and Clerk bearer-token verification.

**Why:** Clerk's production proxy documentation requires the proxy URL to use the same public domain as the application. Pointing `VITE_CLERK_PROXY_URL` directly to a separate Render hostname does not meet that requirement.

**How to apply:** When hosting the frontend and API on separate domains, use a same-domain Pages Function or equivalent trusted edge route for `/api/__clerk`; test Clerk production sign-in, OAuth callbacks, and forwarded host/IP behavior on the actual domain before inviting staff.
