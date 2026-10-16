# Shopping extension security review

Review date: 2026-10-16. Changes target the 0.6.1 source tree.

## Implemented controls

- Normal and login browsers request Chromium sandboxing. Startup fails rather than retrying without it.
- Saved cookies use a private, versioned envelope bound to the configured email fingerprint. Legacy unbound sessions and sessions bound to another configured email require a fresh login.
- Before saving a new session or reusing saved cookies, the server checks the populated readonly email field on the retailer's personal-details page against the configured email. The value is compared internally and is never logged or returned. Missing or mismatched identity fails closed.
- Cart and coupon writes accept only specific retailer controller paths and observed HTTP methods. They reject foreign origins, query strings and fragments in supplied form actions.
- Browser request interception blocks payment, order submission and slot reservation paths before transmission. It also blocks external document navigation. Service workers are disabled so they cannot bypass these browser routes.
- Explicit payment navigation is rejected before creating a browser. API reads and writes do not follow redirects automatically.
- Coupon selection uses fresh basket form fields and verifies the resulting selected IDs. An ambiguous result is reported as unknown and is not automatically replayed.
- Store discovery sends the observed read-only GET request and does not call the store-context or reservation endpoints.
- Basket summaries keep earned loyalty credit separate from the displayed amount to pay. The `immediateDiscounts` value reports order and shipping discounts only; it is not all coupon or line-level savings. Missing credit stays unknown.

## Remaining limits

Changing a password without changing the email does not invalidate the saved envelope. No password-derived fingerprint is stored.

Coupon eligibility and stacking are not inferred from a percentage alone. A selected coupon is not proof that its benefit applies to every product. The basket summary remains provisional.

No fulfilment-context mutation or pickup-slot tool is exposed yet. The non-reserving availability contract has not been verified. The site contains automatic slot-selection code, so opening delivery screens is not used as a substitute for a verified read-only endpoint.

The tests use synthetic coupon, store and session data. Real coupon selections, store changes, reservations and payments were not used for validation.

## Validation

- Typecheck and build passed.
- Full default test suite: 197 tests, 194 passed, zero failed, three opt-in browser tests skipped.
- Package smoke check passed after packing and installing into an isolated temporary directory: 15 tools, CLI transport, instructions and prompt verified.
- The store locator's read-only GET contract and HTML response were checked in the website. Coupon submission fields were checked against the public basket JavaScript. Authenticated coupon mutation and pickup availability were not tested against a real account.

## Dependency audit

`npm audit --omit=dev --json` reported zero production vulnerabilities on the review date.

The full audit reported a high-severity advisory in the development-only chain `@anthropic-ai/mcpb` → `node-forge@1.4.0`: [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv), concerning RSA PKCS#1 v1.5 signature verification. The registry's latest `node-forge` release was 1.4.0 and the audit reported no available fix. No unsupported dependency override was added. Recheck before relying on bundle signature verification.

These checks cover the reviewed code and the reported dependency graph; they do not establish that the retailer or the host environment is free of vulnerabilities.
