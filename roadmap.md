# Divulga Promo
- [ ] B2a: signed server-only Shopee client, signature/rate/error tests, encrypted credentials and Conexões screen; no search, links or reports.
- [x] Requested access adjustments only: 2FA removed by owner decision via new migrations, password-only server login and fixed server audit, reusable password visibility control; 21 tests pass, desktop/mobile public flow verified and quick security scan completed. B2 not started.
- [x] Add account creation directly on the login screen; form and return-to-login verified on desktop/mobile, signup payload tested. Actual signup/email delivery awaits external Supabase settings and owner's test.
- [x] B1 implementation: private access, owner profiles, roles, A5 tables, settings and audit history; 2FA removed by owner decision.
- [x] Verify public screens, signed-out protection, rule tests (13 passing), database linter and security scan.
- [ ] B1 authenticated verification including successful password login and audit readback: external Supabase has one account, but no managed test session or usable sign-in credentials; owner must test their login. No authenticator required.
- [ ] Owner settings: verify email login and enable signup, configure redirect URLs and login rate limits; enable leaked-password protection (security scan informational finding). External hosted Auth configuration cannot be changed with available tools.
- [ ] Owner test of B1 (wait before B2).
- [ ] B2–B9: Later steps, only after approval of the preceding step.