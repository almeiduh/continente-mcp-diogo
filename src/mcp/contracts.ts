import { z } from 'zod';
import { MAX_REFERENCE_LENGTH, isProductReference, CartSchema, ProductDetailsSchema, FavoriteProductSchema, OrderSchema, ProductSchema, PurchaseFrequencySchema,
  ToolErrorSchema, CartMutationResultSchema, CartItemIdSchema, OrderIdSchema, BrowserStatusSchema, FavoritesStatusSchema, UpdateStatusSchema } from '../domain/index.js';

export const ProductReferenceInput = z.string().min(1).max(MAX_REFERENCE_LENGTH).regex(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*(?:\.html)?$/)
  .refine(isProductReference, 'Expected a numeric productId or a product slug ending in it')
  .describe('productId from another tool, such as "00123". A product slug ending in that ID (for example "leite-00123") also works.');
export const LimitInput = z.number().int().min(1).max(50);
export const SearchInput = z.strictObject({
  query: z.string().max(MAX_REFERENCE_LENGTH).regex(/^[^\p{Cc}]*[^\p{Cc}\s][^\p{Cc}]*$/u).describe('Search text, for example "leite meio gordo".'),
  limit: LimitInput.default(10).describe('Maximum products to return (default 10).'),
});
const cartItemId = CartItemIdSchema.optional().describe('Cart line identifier from get_cart. Required to select one of several lines for the same product.');
export const AddCartItemInput = z.strictObject({ productId: ProductReferenceInput,
  quantity: z.number().positive().default(1).describe('Amount to add, in the product sale unit (default 1).'), cartItemId });
export const SetCartItemQuantityInput = z.strictObject({ productId: ProductReferenceInput,
  quantity: z.number().nonnegative().describe('Desired total in the product sale unit. Zero removes the item.'), cartItemId });
export const RemoveCartItemInput = z.strictObject({ productId: ProductReferenceInput, cartItemId });
export const GetOrderInput = z.strictObject({ orderId: OrderIdSchema.describe('Internal orderId from list_orders; distinct from the displayed order number.') });
export const EmptyInput = z.strictObject({});
export const FavoritesInput = z.strictObject({
  refresh: z.boolean().default(false).describe('Fetch the current list from the website instead of using the local snapshot.'),
});
export const ListOrdersInput = z.strictObject({ limit: LimitInput.default(5).describe('Maximum order summaries to return (default 5).'),
  includeLines: z.boolean().default(true).describe('Read product lines for the returned orders.'),
  detailLimit: z.number().int().min(0).max(50).optional().describe('Maximum returned summaries to enrich with lines; defaults to limit. Zero skips details.'),
  cursor: z.string().min(1).max(4096).optional().describe('Opaque nextCursor returned by list_orders.') });
export const FrequentlyBoughtInput = z.strictObject({
  orderLimit: LimitInput.default(10).describe('Maximum recent orders to scan.'),
  limit: LimitInput.default(25).describe('Maximum ranked products to return.'),
});

export const PublicErrorSchema = ToolErrorSchema.extend({ code: z.union([ToolErrorSchema.shape.code, z.enum(['internal_error', 'invalid_result'])]) });
const RecoverySchema = z.strictObject({ action: z.literal('get_cart'), automaticReplay: z.literal(false) });
/** What to do about a sign-in failure, so an assistant can guide the user without parsing the message. */
export const SignInRecoverySchema = z.strictObject({
  credentials: z.enum(['configured', 'missing', 'unknown']),
  /** `configure_credentials` when none are set; otherwise check them, or sign in once in a visible browser. */
  action: z.enum(['configure_credentials', 'check_credentials_or_sign_in']),
  settings: z.strictObject({
    environment: z.tuple([z.literal('CONTINENTE_EMAIL'), z.literal('CONTINENTE_PASSWORD')]),
    claudeDesktopExtension: z.tuple([z.literal('email'), z.literal('password')]),
  }),
  /** Run in a terminal to sign in and complete any extra verification. */
  command: z.literal('continentept-mcp login --show-browser'),
  guide: z.url(),
  /** Tools that keep working without signing in. */
  publicTools: z.array(z.string()),
});
export const ErrorResultSchema = z.strictObject({ status: z.literal('error'), error: PublicErrorSchema,
  mutation: z.discriminatedUnion('outcome', [
    z.strictObject({ outcome: z.literal('not_applied') }),
    z.strictObject({ outcome: z.literal('unknown'), recovery: RecoverySchema }),
  ]).optional(),
  signIn: SignInRecoverySchema.optional(),
});
export const ExecutionErrorSchema = z.strictObject({ result: ErrorResultSchema });
export function outputSchema<T extends z.ZodType>(data: T, extra: z.ZodRawShape = {}) {
  return z.strictObject({ result: z.union([
    z.strictObject({ status: z.enum(['success', 'empty', 'partial']), data }), ErrorResultSchema,
  ]), ...extra });
}
const integer = z.number().int().nonnegative();
export const SearchData = z.strictObject({ products: z.array(ProductSchema.safeExtend({ favorite: z.boolean() })),
  scanned: integer, returned: integer, favoritesLoaded: integer, completeness: z.enum(['complete', 'partial', 'unknown']),
  failures: z.array(ToolErrorSchema), nextCursor: z.string().nullable() });
export const FavoritesData = z.strictObject({ favorites: z.array(FavoriteProductSchema), fetchedAt: z.iso.datetime({ offset: true }), completeness: z.enum(['complete', 'unknown']),
  source: z.enum(['cache', 'website']), freshness: z.enum(['fresh', 'stale']), expiresAt: z.iso.datetime({ offset: true }), cacheState: z.enum(['empty', 'populated']) });
const ScanFailure = z.strictObject({ stage: z.enum(['listing', 'detail']), orderId: OrderSchema.shape.orderId, orderNumber: OrderSchema.shape.orderNumber, error: ToolErrorSchema });
export const OrdersData = z.strictObject({ orders: z.array(OrderSchema), completeness: z.enum(['complete', 'partial', 'unknown']), failures: z.array(ToolErrorSchema), nextCursor: z.string().nullable(),
  hasMore: z.boolean().nullable(), detailBudget: integer, detailsRead: integer, scanFailures: z.array(ScanFailure) });
export const FrequencyData = z.strictObject({ products: z.array(PurchaseFrequencySchema), listed: integer, scanned: integer, succeeded: integer, failed: integer, unscanned: integer,
  unknownQuantityLines: integer, failures: z.array(ScanFailure), completeness: z.enum(['complete', 'partial', 'unknown']), nextCursor: z.string().nullable() });
export const SearchOutput = outputSchema(SearchData);
export const FavoritesOutput = outputSchema(FavoritesData);
export const CartOutput = outputSchema(CartSchema);
const ConfirmedMutationData = CartMutationResultSchema.options[0].refine(value => value.requested.unit === value.confirmedQuantity.unit);
export const MutationOutput = outputSchema(ConfirmedMutationData);
export const OrdersOutput = outputSchema(OrdersData);
export const SingleOrderOutput = outputSchema(z.strictObject({ order: OrderSchema, unknownQuantityLines: integer }));
export const FrequencyOutput = outputSchema(FrequencyData, { scan: FrequencyData.optional() });
export const SessionStatusOutput = outputSchema(BrowserStatusSchema.extend({ favorites: FavoritesStatusSchema, update: UpdateStatusSchema }));

export const GetProductInput = z.strictObject({ productId: ProductReferenceInput });
export const ProductDetailsOutput = outputSchema(ProductDetailsSchema);
