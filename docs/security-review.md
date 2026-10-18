# Shopping extension security review

Review date: 2026-10-18. Changes target the 0.6.1 source tree.

## Implemented controls

- Normal and login browsers request Chromium sandboxing. Startup fails rather than retrying without it.
- Saved cookies use a private, versioned envelope bound to the configured email fingerprint. Legacy unbound sessions and sessions bound to another configured email require a fresh login.
- Before saving a new session or reusing saved cookies, the server checks the populated readonly email field on the retailer's personal-details page against the configured email. The value is compared internally and is never logged or returned. Missing or mismatched identity fails closed.
- Cart and coupon writes accept only specific retailer controller paths and observed HTTP methods. They reject foreign origins, query strings and fragments in supplied form actions.
- Browser request interception blocks payment, order submission and slot reservation paths before transmission. It also blocks external document navigation. Service workers are disabled so they cannot bypass these browser routes.
- Explicit payment navigation is rejected before creating a browser. API reads and writes do not follow redirects automatically.
- Coupon selection uses fresh basket form fields and verifies the resulting selected IDs. An ambiguous result is reported as unknown and is not automatically replayed.
- Store discovery sends the observed read-only GET request and does not call the store-context or reservation endpoints.
- `set_pickup_store` accepts only a fresh primary-store option, calls the exact observed coverage GET and context POST endpoints, and reads the selected-store context back. An uncertain POST is never retried; a confirmed change asks callers to re-read cart/coupon context.
- `list_pickup_slots` reads raw server-rendered HTML and reports slots only when one primary pickup step, selected radio, current store marker and shipment identifiers agree. Date windows are limited to the next 31 days because the retailer omits the year from slot labels.
- Basket summaries keep earned loyalty credit separate from the displayed amount to pay. The `immediateDiscounts` value reports order and shipping discounts only; it is not all coupon or line-level savings. Missing credit stays unknown.

## Remaining limits

Changing a password without changing the email does not invalidate the saved envelope. No password-derived fingerprint is stored.

Coupon eligibility and stacking are not inferred from a percentage alone. A selected coupon is not proof that its benefit applies to every product. The basket summary remains provisional.

Pickup-store context mutation is supported through `set_pickup_store`; pickup-slot reservation remains unavailable. `list_pickup_slots` reads only slot data already rendered in server HTML; it does not execute the delivery page's automatic slot-selection JavaScript or request additional dates. Results therefore remain partial when any slots are present. The website UI was inspected for a store change and visibly auto-selected a slot on delivery-page load; no slot was clicked, reserved, or submitted by this implementation. The MCP tools themselves use direct HTTP reads and do not run that page JavaScript.

The current verified mutation contract changes stores only after pickup mode is already active. Switching from home delivery to pickup is not exposed because its selected-context/readback contract has not been verified.

The tests use synthetic coupon, store and session data. The public store coverage response's numeric ID types and UI context transition were observed; no store-change POST was issued by the implementation. The MCP mutation clients were tested with synthetic transports. Live browser store changes were observed and the starting store was restored; the retailer UI automatically selected a slot when loaded. No slot control or payment control was clicked by the assistant, and no payment page was opened.

## Validation

- Typecheck and build passed.
- Before the pickup extension, the default suite passed: 197 tests, 194 passed, zero failed, three opt-in browser tests skipped.
- For the final pickup extension, 36 compiled test files passed. The foundation and stdio test files could not complete successfully in this host environment; their CLI child launches hit `spawnSync .../runtime/bin/node EPERM`. This is not a fully green final test run.
- The earlier 15-tool package smoke check passed. The final 17-tool package smoke check remains pending because this environment blocks its nested CLI launches.
- The store locator's read-only GET contract and HTML response were checked in the website. Slot attributes and the selected pickup marker were observed on the delivery page; fixtures remain synthetic. Coupon submission fields were checked against the public basket JavaScript. Authenticated MCP coupon mutation and slot-reader calls were not tested against a real account.

## Dependency audit

`npm audit --omit=dev --json` reported zero production vulnerabilities on the review date.

The full audit reported a high-severity advisory in the development-only chain `@anthropic-ai/mcpb` → `node-forge@1.4.0`: [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv), concerning RSA PKCS#1 v1.5 signature verification. The registry's latest `node-forge` release was 1.4.0 and the audit reported no available fix. No unsupported dependency override was added. Recheck before relying on bundle signature verification.

These checks cover the reviewed code and the reported dependency graph; they do not establish that the retailer or the host environment is free of vulnerabilities.
