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
- Keep private pages under the Supabase authenticated layout with server/RLS enforcement; MFA has been removed by owner decision, while navigation alone remains insufficient as a security boundary.
- Store encrypted connector secrets in a server-only table, separate from browser-readable connection metadata, to prevent credential disclosure.
- Store publication defaults in user-owned settings and validate them server-side; future publishing steps must consume this central source.
- Password login runs in a public CSRF-protected server function using Supabase Auth's rate limits and writes a fixed audit row only after successful authentication; settings audit rows remain trigger-generated, so clients cannot fabricate history.
- Use the shared PasswordInput for every password field to preserve manager autocomplete and reset visibility on submission or screen changes.
- Keep account creation in the shared login screen, using Supabase Auth and its profile trigger; only an actual returned session allows immediate entry, so email confirmation is never bypassed.
- Shopee transport and AES-GCM encryption live in server-only modules behind authenticated server functions; bind ciphertext to the owner and keep signature payloads byte-identical to prevent leaks and authentication drift.
- Reserve Shopee requests atomically in connector_runtime, never in worker memory; transaction-only service RPCs manage encrypted credentials and audit results to survive concurrent requests and stateless deployment.
- Shopee conversion sync runs as one bounded window per tick from a persisted queue (shopee_sync_state) with a DB lock and per-user 31s gap; stateless workers cannot hold paging state.
