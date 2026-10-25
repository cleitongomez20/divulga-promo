<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- Use TanStack Start server functions for app-internal server logic, as approved by the user; third-party requests and secrets never run in the browser.
- Keep private pages under the Supabase authenticated layout, with a separate MFA gate and server/RLS enforcement; navigation alone is not a security boundary.
- Store encrypted connector secrets in a server-only table, separate from browser-readable connection metadata, to prevent credential disclosure.
- Store publication defaults in user-owned settings and validate them server-side; future publishing steps must consume this central source.
- Auth audit rows are server-generated after verified access, and settings audit rows are written by a database trigger; clients cannot fabricate history.
- Keep account creation in the shared login screen, using Supabase Auth and its profile trigger; only an actual returned session allows immediate entry, so email confirmation is never bypassed.
