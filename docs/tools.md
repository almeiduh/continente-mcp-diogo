# Tool reference

Continente MCP exposes 11 tools, server instructions and one prompt. Every tool has a strict
input schema (unknown fields are rejected), an output schema, a title and the four MCP
behaviour annotations.

| Tool | Login | Changes the cart | Inputs |
| --- | --- | --- | --- |
| `search_products` | No | No | `query`, `limit` (1–50, default 10) |
| `get_product` | No | No | `productId` |
| `list_favorites` | Yes | No | `refresh` (default `false`) |
| `get_cart` | Yes | No | — |
| `add_cart_item` | Yes | Yes | `productId`, `quantity` (> 0, default 1), `cartItemId?` |
| `set_cart_item_quantity` | Yes | Yes | `productId`, `quantity` (≥ 0), `cartItemId?` |
| `remove_cart_item` | Yes | Yes | `productId`, `cartItemId?` |
| `list_orders` | Yes | No | `limit` (1–50, default 5), `includeLines` (default `true`), `detailLimit?` (0–50), `cursor?` |
| `get_order` | Yes | No | `orderId` |
| `list_frequently_bought_products` | Yes | No | `orderLimit` (1–50, default 10), `limit` (1–50, default 25) |
| `get_session_status` | No | No | — |

"Login" means the tool reads the account. If the saved session has expired, the server signs in
again once with the configured credentials before reporting `not_authenticated`.

## Identifiers

| Field | Meaning |
| --- | --- |
| `productId` | Numeric product ID as a string. Leading zeroes matter (`"00123"`). Inputs also accept a product slug ending in the ID, such as `leite-meio-gordo-00123`, optionally with `-master` or `.html`. Full URLs are not accepted. |
| `cartItemId` | One cart line, from `get_cart`. Needed only when a product has more than one line. |
| `orderId` | Internal order ID from `list_orders`, used by `get_order`. |
| `orderNumber` | The order number shown on the website. Display only. |

## Results

Every call returns text content and `structuredContent.result`:

```json
{ "result": { "status": "success", "data": { "...": "..." } } }
```

| `status` | Meaning |
| --- | --- |
| `success` | The request completed. |
| `empty` | The request completed with nothing to return. |
| `partial` | Some work failed; the data that was read is included along with the failures. |
| `error` | `isError` is `true` and `result.error` has `code`, `message` and `retryable`. |

The text content is a readable summary that includes every identifier needed for follow-up
calls, for clients that do not pass structured content to the model.

### Values

- **Money** is `{ "currency": "EUR", "minorUnits": 129 }` (€1.29).
- **Catalogue prices** (search, favorites, `get_product`) are `{ amount, per }`, saying what the
  price is for: `item` (one pack or article), `piece` (one unit, often approximate for
  produce), `kg` or `l`. Produce and meat show their main `price` per kg, with an approximate
  per-piece `secondaryPrice`; packaged goods show the pack price with a per-kg or per-litre
  `secondaryPrice`. A price per kg or per litre is not the price of one pack. An unknown or
  unrecognised price is `null`.
- **Cart prices** are `{ amount, basis }`, where `basis` is `unit`, `line` (a line total) or
  `unknown`.
- **Quantities** are `{ value, unit }` with unit `un`, `kg`, `g`, `l` or `ml`. Quantities read
  from the website are either `{ status: "known", quantity }` or
  `{ status: "unknown", value, rawText, reason }`; an unknown unit is never guessed.
- **Completeness** (`complete`, `partial`, `unknown`) describes the pages that were read, not
  the whole catalogue or account history. Searches read at most five result pages and order
  listings at most ten.

## Catalogue

### `search_products`

Searches the public catalogue. Results keep the website's order, which reflects relevance to
the query, except that products in your saved favorites move to the front (`favorite: true`).
Search uses the local favorites snapshot and never signs in to refresh it.

Each product has `productId`, `productSlug`, `name`, `url`, `price`, `secondaryPrice`,
`packageText` (the pack size as shown, such as `940 gr`, `2 x 52 gr` or
`400 gr (peso escorrido 260 gr)`), `minimumText` (a minimum purchase such as `600 gr (3 un)`),
`recommendedPrice` and `favorite`.

`recommendedPrice` is the recommended retail price (PVPR) the website shows beside the price
on many promotions, or `null` when it shows none. Promotions such as multi-buy offers have no
PVPR, so it is not a complete list of promotions. Compare it with `price` rather than treating
its presence as a discount.

A result the server cannot read does not fail the search. It is skipped, or kept with an
unknown price when only the price is unreadable, and described in `failures`; the result is
then `partial`.

`data`: `products`, `scanned`, `returned`, `favoritesLoaded`, `completeness`, `failures`,
`nextCursor`.

### `get_product`

Returns `productId`, `productSlug`, `name`, `url`, `price`, `secondaryPrice`, `recommendedPrice`
(as in `search_products`), `availability`
(`available`, `unavailable` or `unknown`) and `saleRules`:

```json
{ "status": "available", "rules": { "saleUnit": "un", "storefrontUnit": "un", "storefrontUnitsPerSaleUnit": 1,
  "minimum": { "value": 1, "unit": "un" }, "maximum": { "value": 10, "unit": "un" }, "step": { "value": 1, "unit": "un" } } }
```

Cart quantities are always in `saleUnit`. Products priced per kilogram but sold by the piece
(fruit, meat, fish) have `saleUnit: "un"` and `storefrontUnit: "kg"`: their minimum, maximum and
step are whole pieces, and `storefrontUnitsPerSaleUnit` is the approximate weight of one piece. If the website's rules cannot be interpreted
safely, `saleRules` is `{ "status": "unavailable", "error": ... }` and the result is
`partial`. Availability reflects the product page, not delivery-slot stock.

## Favorites

### `list_favorites`

Returns the favorites saved on the account from a local snapshot. The snapshot is fetched
automatically when missing, is marked `stale` after 24 hours, and is replaced when you pass
`refresh: true`. A failed refresh keeps the previous snapshot.

`data`: `favorites`, `fetchedAt`, `expiresAt`, `source` (`cache` or `website`), `freshness`
(`fresh` or `stale`), `cacheState` (`empty` or `populated`), `completeness`.

## Cart

### `get_cart`

`data`: `customerAuthenticated`, `items` (each with `productId`, `cartItemId`, `name`, `kind`,
`quantity`, `price`) and `totals`.

- `kind` is `bag` for the shopping bags the website adds to the cart by itself, and `product`
  for everything else.
- `quantity` is in the line's sale unit, read from the line's own sale rules: pieces (`un`) for
  products sold by the piece but priced per kg, `un` for everything else. A line without
  recognisable sale rules keeps its amount with an unknown unit.
- `totals` holds each amount as the website reports it, or `null` when it reports none:

  | Field | Meaning |
  | --- | --- |
  | `products` | Product lines only, without bags or deposit |
  | `bags` | The bag lines |
  | `deposit` | Bottle and can deposit (SDR) |
  | `delivery` | Delivery cost, once the website has one |
  | `discounts` | Amount taken off by order and delivery discounts |
  | `grandTotal` | The amount to pay as the website shows it. It includes the bags. |

  Report `grandTotal` as the amount to pay, and don't add the other fields to it yourself.

### Changing the cart

| Tool | Behaviour |
| --- | --- |
| `add_cart_item` | Adds `quantity` to whatever is already in the cart. Not idempotent. |
| `set_cart_item_quantity` | Makes the cart hold exactly `quantity`, adding the product if it is absent. Zero removes it. Repeating the same call makes no further change. |
| `remove_cart_item` | Removes the line. If it is already absent, succeeds without a write (`disposition: "already_absent"`). |

Quantities are validated against the product's sale rules (minimum, maximum, step and
three-decimal storefront precision) before anything is sent. An invalid amount fails with
`invalid_input` or `quantity_below_minimum` and is never rounded. Every successful change is
confirmed by reading the cart back:

```json
{ "result": { "status": "success", "data": { "outcome": "confirmed", "productId": "00123",
  "requested": { "value": 2, "unit": "un" }, "confirmedQuantity": { "value": 5, "unit": "un" } } } }
```

`requested` is the amount from the call (the increment for `add_cart_item`);
`confirmedQuantity` is the quantity now in the cart.

#### Failed and uncertain changes

A failed change has `isError: true` and a `mutation` field:

- `{ "outcome": "not_applied" }`: nothing was submitted, or the website rejected the change.
- `{ "outcome": "unknown", "recovery": { "action": "get_cart", "automaticReplay": false } }`:
  the request was sent but could not be confirmed (timeout, cancellation, lost response or
  failed readback). **The cart may have changed.** Call `get_cart` and decide from the actual
  state. Never repeat the request automatically, including `add_cart_item`.

```json
{ "result": { "status": "error",
  "error": { "code": "cart_change_unconfirmed", "message": "cart_change_unconfirmed", "retryable": false },
  "mutation": { "outcome": "unknown", "recovery": { "action": "get_cart", "automaticReplay": false } } } }
```

## Orders

### `list_orders`

Returns recent order summaries, newest first. `limit` counts summaries; `detailLimit`
(default: `limit`) caps how many of them have their product lines read, and
`includeLines: false` skips lines entirely. Each order's `lines` is `available` (with
`items`), `unavailable` (with `error`) or `not_requested`. Pass `nextCursor` back as `cursor`
to continue; if the history changed in between, restart without a cursor.

`data`: `orders`, `completeness`, `failures`, `nextCursor`, `hasMore`, `detailBudget`,
`detailsRead`, `scanFailures`.

### `get_order`

Reads one order by `orderId`. `data`: `order`, `unknownQuantityLines`.

### `list_frequently_bought_products`

Reads up to `orderLimit` recent orders and ranks products by the number of orders that
contained them, then by total units. Products are grouped by `productId`; lines without one
are grouped by name (`identityBasis: "name"`). Totals are kept separate per unit, and lines
with unknown quantities are counted in `unknownQuantityLines` instead of being guessed.

`data`: `products`, `listed`, `scanned`, `succeeded`, `failed`, `unscanned`,
`unknownQuantityLines`, `failures`, `completeness`, `nextCursor`. If no order details could
be read at all, the result is an `order_details_unavailable` error with the statistics in a
top-level `scan` field.

## Session

### `get_session_status`

Reports local state without opening a browser or contacting the website: `browser`
(`closed`, `starting`, `ready`), `credentials` (`hasEmail`, `hasPassword`), `savedCookies`
(`available`, `missing`, `unavailable`), `authentication` (the last observed login state and
when it was observed), `favorites` (snapshot state and expiry) and `update` (`currentVersion`,
`latestVersion` and whether a newer release is `available`). It never returns
credentials, cookies or file paths.

## Error codes

| Code | Meaning |
| --- | --- |
| `invalid_input` | The request cannot be applied, for example an off-step quantity or an ambiguous cart line. |
| `quantity_below_minimum` | The resulting quantity is below the product minimum. |
| `sale_rules_unknown` | The product's sale rules could not be interpreted safely. |
| `not_found` | The product, cart line or order does not exist. |
| `not_authenticated` | Sign-in is required and automatic sign-in failed or is not configured. The message says which, and what to do. |
| `upstream_unavailable` | The website could not be reached or returned an error. |
| `invalid_data` | The website returned something the server does not recognise. |
| `order_details_unavailable` | Order details could not be read. |
| `cart_change_rejected` | The website rejected the cart change. |
| `cart_change_unconfirmed` | The cart change could not be confirmed. |
| `cache_unavailable` | The local favorites snapshot could not be read or written. |
| `browser_unavailable` | Chromium is still downloading for first use, or the download failed. Retryable. |
| `cancelled`, `deadline_exceeded`, `server_closed`, `queue_full` | The request stopped before completing. |
| `internal_error`, `invalid_result` | Unexpected server failure. Details are not exposed. |

Invalid arguments and unknown tools are JSON-RPC errors (`-32602`), not tool results.

## Instructions and prompt

The server sends **instructions** when a client connects: the quantity, cart-change and
uncertain-outcome rules described above, in a few lines. Clients such as Claude include them
in the assistant's context automatically. When a newer release exists, the instructions also
say so, so the assistant can tell the user.

It also offers one **prompt**, `basket-planner` ("Plan a Continente basket"). It returns the
full shopping workflow as a user message. Its optional `request` argument, such as
`weekly basket for two`, is appended to the workflow. The text is the same as the
[`basket-planner` skill](../skills/basket-planner/SKILL.md).

## Limits and lifecycle

- Calls run one at a time. Each call has a 45-second budget, including time spent waiting.
  At most 32 calls can wait; more fail with `queue_full`.
- Cancelling a call before a cart change is sent reports `not_applied`; after that it reports
  `unknown`.
- The browser starts on first use and closes after five idle minutes
  (`CONTINENTE_BROWSER_IDLE_SECONDS`). Saved cookies and favorites are kept.
- Progress notifications are sent for multi-page reads when the client supplies a
  `progressToken`.
