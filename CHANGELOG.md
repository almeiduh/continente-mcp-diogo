# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- **Breaking:** `search_products` keeps the website's relevance order. Saved favorites are still marked `favorite: true`, but only move to the top with the new `favoritesFirst: true`, and then only within the returned products.

### Added

- `search_products` accepts `cursor`: pass `nextCursor` back with the same query to continue right after the last product returned. Following cursors never skips or repeats a result. Before, products read beyond `limit` were dropped and `nextCursor` could not be used.
- `search_products`, `get_product` and `get_cart` return `observedAt`, when the website was read.
- Cart lines and totals have `estimated`: products sold by the piece but priced by weight are charged by the weight picked, so their line total, and then the cart totals, are estimates. `get_cart` text says "about" for them.

- `search_products` and `get_product` return `package`, the pack label read into numbers: `count`, `each`, `net` (including any free extra), `drained` and `approximate`. For example, `6 x 1 lt` is 6 items of 1 l, 6 l in total. A label with an unknown part gives `null`.
- `get_product` returns `packageText` and `minimumText`, like `search_products`, and shows the pack size in its text.
- A `not_authenticated` error before any cart write carries `signIn`: whether credentials are configured, what to do next, the settings and command involved, and which tools work without signing in.

## [0.6.1] - 2026-10-15

### Fixed

- The first request after the browser started could fail with "The order history page was not recognised", or a search error, while the website was still setting up its session. A page that does not show what it should is now loaded once more.
- Order dates with abbreviated months, as the website now shows them ("01 Set 26"), are read. They were all `null`.
- `get_product` reports a product the website no longer sells as `not_found`, instead of `invalid_data`.
- After an upgrade, the update check no longer reports an older version as the latest one.

## [0.6.0] - 2026-10-15

### Changed

- **Breaking:** `get_cart` returns `totals` instead of `total`: `products`, `bags`, `deposit`, `delivery`, `discounts` and `grandTotal`, the amount to pay. The old `total` left out the bags, so it was less than the amount to pay.
- **Breaking:** cart line prices are `{ amount, per }` price tags, like catalogue prices, plus a `lineTotal`. Products sold by the piece but priced by weight were shown as a price "each" when it was the price per kg.

### Added

- Cart lines have a `kind`, `bag` for the shopping bags the website adds by itself and `product` for everything else.
- `search_products` and `get_product` return `recommendedPrice`, the recommended retail price (PVPR) the website shows beside the price on many promotions, so assistants can compare it with the selling price. ([#4](https://github.com/andredelgado/continente-mcp/pull/4), thanks [@Lozano-Miguel](https://github.com/Lozano-Miguel))

### Fixed

- Products sold by the piece but priced per kilogram (fruit, vegetables, meat, fish, counter cheese and ham) had no sale rules, so they could not be added to the cart. Their maximum is now read in kilograms, like the minimum and step, and converted to whole pieces.
- Cart quantities now have a unit. They were all reported as `unknown`; each line's unit now comes from its own sale rules, so a weighted line reads as pieces. A cart change is no longer confirmed by a line that reports another unit.

## [0.5.0] - 2026-10-15

### Fixed

- Searching for produce, meat and other products priced per kilogram failed with "Invalid money amount". Prices now record what they are for: per item, per piece, per kg or per litre.
- One unreadable search result no longer fails the whole search; the other results are returned as a partial result, and the unreadable one is described.
- Search results keep the website's relevance order. Products whose names merely resembled a favorite no longer jump ahead of better matches; exact favorites still come first.
- Favorites priced per kilogram are read correctly, and an unrecognised favorite price is reported as unknown instead of failing the refresh.

### Changed

- **Breaking:** catalogue prices (`price` in search, favorites and `get_product`) are now `{ amount, per }`. `unitPriceText` is replaced by `secondaryPrice`, and the search field `similarity` is removed. Saved favorites are fetched again once after updating.
- Search results include `packageText`, the pack size as shown on the website.
- Sign-in errors say whether no credentials are configured or Continente did not accept them, with the next step for each case. The instructions present the `basket-planner` prompt as optional, for clients that support prompts.
- Browser engine updated to Playwright 1.64 (Chrome 156). After updating, the new Chromium downloads automatically on first use (about 150 MB, once).

## [0.4.0] - 2026-10-15

### Added

- Update notice: once a day the server checks npm for a newer release and, if there is one, tells the assistant and reports it in `get_session_status`. Offline-safe; turn it off with `CONTINENTE_UPDATE_CHECK=0`.

### Fixed

- Documentation: how the home folder is chosen on Windows, what "readable only by your user" covers, when the favorites snapshot is refetched, and what deleting the data directory removes.

### Security

- A failed sign-in could write the account password or session cookies to the server log, because browser automation errors include what was typed and the request headers. Sign-in errors are now reported as fixed messages naming only the failed step.

## [0.3.1] - 2026-10-15

### Added

- Listed in the official [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.andredelgado/continente-mcp`, with both the npm package and the Claude Desktop extension. Every release updates the listing.

## [0.3.0] - 2026-10-15

### Added

- One-click Claude Desktop extension (`continente-mcp.mcpb`) attached to every release. It asks for your email and password at install time.
- Chromium downloads automatically the first time it is needed; `install-browser` is now optional. While it downloads, tools return a retryable `browser_unavailable` error explaining the wait.

## [0.2.0] - 2026-10-15

### Added

- Server instructions: assistants receive the cart rules (exact totals, one change at a time, check the cart after an uncertain change) as soon as they connect.
- A `basket-planner` prompt with the full shopping workflow, with an optional request to plan for. No skill install is needed.
- Documentation for supplying credentials from 1Password with `op run`.

### Changed

- The `basket-planner` skill links to the online tool reference, so it also works when uploaded on its own.

## [0.1.0] - 2026-10-15

### Added

- Catalogue search and product details with exact prices, availability and sale rules.
- Cart tools that confirm every change by reading the cart back and report uncertain changes instead of retrying them.
- Favorites, order history and a ranking of frequently bought products.
- Automatic sign-in from environment variables or a private credentials file, and a `login` command.
- The `basket-planner` skill for planning a shopping list and updating the basket.

[Unreleased]: https://github.com/andredelgado/continente-mcp/compare/v0.6.1...HEAD
[0.6.1]: https://github.com/andredelgado/continente-mcp/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/andredelgado/continente-mcp/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/andredelgado/continente-mcp/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/andredelgado/continente-mcp/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/andredelgado/continente-mcp/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/andredelgado/continente-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/andredelgado/continente-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/andredelgado/continente-mcp/releases/tag/v0.1.0
