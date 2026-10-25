# Divulga Promo
- [x] Add account creation directly on the login screen; form and return-to-login verified on desktop/mobile, signup payload tested. Actual signup/email delivery awaits external Supabase settings and owner's test.
- [x] B1 implementation: private access, owner profiles, roles, mandatory admin MFA, A5 tables, settings and audit history.
- [x] Verify public screens, signed-out protection, rule tests (13 passing), database linter and security scan.
- [ ] B1 authenticated verification: blocked because external Supabase has no accounts and no managed test session; owner must create account and complete MFA.
- [ ] Owner settings: verify email login and enable signup, configure redirect URLs and login rate limits; enable leaked-password protection (security scan informational finding). External hosted Auth configuration cannot be changed with available tools.
- [ ] Owner test of B1 (wait before B2).
- [ ] B2–B9: Later steps, only after approval of the preceding step.