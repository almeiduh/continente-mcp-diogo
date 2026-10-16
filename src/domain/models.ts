import { z } from 'zod';
import { ToolErrorSchema } from './errors.js';
import { CartItemIdSchema, OrderIdSchema, OrderNumberSchema, ProductIdSchema, ProductReferenceSchema } from './identity.js';
import { MoneySchema, PriceTagSchema } from './money.js';
import { ObservedQuantitySchema, QuantitySchema, ProductSaleRulesSchema } from './quantity.js';

const productDetails = {
  name: z.string().trim().min(1).max(250),
  /** The main price as displayed; null when absent or unrecognised. */
  price: PriceTagSchema.nullable(),
  url: z.url(),
};
/** Pack details parsed from the label; parts the label does not state are null. */
export const PackageSchema = z.strictObject({
  /** Items in the pack: the 6 in `6 x 1 lt`, the 12 in `12 rolos`, 1 for a single item. */
  count: z.number().int().positive().nullable(),
  /** Quantity of one item, when the label states it. */
  each: QuantitySchema.nullable(),
  /** Total quantity in the pack, including any free extra. */
  net: QuantitySchema.nullable(),
  /** Drained weight of preserves (`peso escorrido`). */
  drained: QuantitySchema.nullable(),
  /** The weight is approximate, as for products sold by the piece. */
  approximate: z.boolean(),
});
export type Package = z.infer<typeof PackageSchema>;
const packDetails = {
  /** Pack size as displayed, such as `940 gr`, `2 x 52 gr` or `1,2 kg (aprox.)`. */
  packageText: z.string().nullable(),
  package: PackageSchema.nullable(),
  /** Minimum purchase as displayed, such as `600 gr (3 un)`. */
  minimumText: z.string().nullable(),
};
export const FavoriteProductSchema = ProductReferenceSchema.safeExtend(productDetails);
export type FavoriteProduct = z.infer<typeof FavoriteProductSchema>;
export const ProductSchema = FavoriteProductSchema.safeExtend({
  /** The comparison price shown next to the main one, such as per kg or per piece. */
  secondaryPrice: PriceTagSchema.nullable(),
  /** The recommended retail price (PVPR) shown beside a promotional price; null when the website shows none. */
  recommendedPrice: PriceTagSchema.nullable(),
  ...packDetails,
  /** Whether the results page offers the product: `unknown` unless its badge and add button agree. */
  availability: z.enum(['available', 'unavailable', 'unknown']),
});
export type Product = z.infer<typeof ProductSchema>;

export const CartItemSchema = z.strictObject({
  productId: ProductIdSchema,
  cartItemId: CartItemIdSchema.nullable(),
  name: z.string().trim().min(1),
  /** `bag` for the shopping bags the website adds to the cart on its own; `product` for everything else. */
  kind: z.enum(['product', 'bag']),
  quantity: ObservedQuantitySchema,
  /** Unit price with what it is for: per item, or per kg for products sold by the piece but priced by weight. */
  price: PriceTagSchema.nullable(),
  /** The line's total as the website reports it. */
  lineTotal: MoneySchema.nullable(),
  /** The line total is an estimate: products sold by the piece but priced by weight are charged by the weight picked. */
  estimated: z.boolean(),
});
export type CartItem = z.infer<typeof CartItemSchema>;
/** Each amount as the website reports it, or null when it reports none. */
export const CartTotalsSchema = z.strictObject({
  /** Product lines only, without bags or deposit. */
  products: MoneySchema.nullable(),
  /** The bag lines. */
  bags: MoneySchema.nullable(),
  /** Bottle and can deposit (SDR). */
  deposit: MoneySchema.nullable(),
  delivery: MoneySchema.nullable(),
  /** Amount taken off by order and delivery discounts. */
  discounts: MoneySchema.nullable(),
  /** The amount to pay as the website shows it; it includes the bags. */
  grandTotal: MoneySchema.nullable(),
  /** Some lines are estimates, so `products` and `grandTotal` are too. */
  estimated: z.boolean(),
});
export type CartTotals = z.infer<typeof CartTotalsSchema>;
export const CartSchema = z.strictObject({
  customerAuthenticated: z.boolean(),
  items: z.array(CartItemSchema),
  totals: CartTotalsSchema,
});
export type Cart = z.infer<typeof CartSchema>;

export const OrderLineSchema = z.strictObject({
  productId: ProductIdSchema.nullable(),
  name: z.string().trim().min(1),
  quantity: ObservedQuantitySchema,
});
export type OrderLine = z.infer<typeof OrderLineSchema>;
export const OrderSchema = z.strictObject({
  orderId: OrderIdSchema.nullable(),
  orderNumber: OrderNumberSchema.nullable(),
  date: z.string().nullable(),
  rawDate: z.string().nullable().optional(),
  lines: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('available'), items: z.array(OrderLineSchema) }),
    z.strictObject({ status: z.literal('unavailable'), error: ToolErrorSchema }),
    z.strictObject({ status: z.literal('not_requested') }),
  ]),
});
export type Order = z.infer<typeof OrderSchema>;

export const PurchaseFrequencySchema = z.strictObject({
  productId: ProductIdSchema.nullable(),
  identityBasis: z.enum(['product', 'name']),
  name: z.string().trim().min(1),
  quantities: z.array(QuantitySchema),
  orders: z.number().int().positive(),
  unknownQuantityLines: z.number().int().nonnegative().optional(),
}).refine(frequency => (frequency.identityBasis === 'product') === (frequency.productId !== null),
{ message: 'Identity basis must agree with the available product ID' })
  .refine(frequency => new Set(frequency.quantities.map(quantity => quantity.unit)).size === frequency.quantities.length,
  { message: 'Purchase totals must contain each unit only once' });
export type PurchaseFrequency = z.infer<typeof PurchaseFrequencySchema>;

export const FavoritesCacheSchema = z.strictObject({
  schemaVersion: z.literal(2),
  accountScope: z.string().trim().min(1).max(128),
  fetchedAt: z.iso.datetime({ offset: true }),
  favorites: z.array(FavoriteProductSchema),
  completeness: z.literal('complete').optional(),
});
export type FavoritesCache = z.infer<typeof FavoritesCacheSchema>;

export const ProductDetailsSchema = ProductReferenceSchema.safeExtend({
  name: productDetails.name, url: productDetails.url, price: PriceTagSchema.nullable(),
  secondaryPrice: PriceTagSchema.nullable(), recommendedPrice: PriceTagSchema.nullable(), ...packDetails, availability: z.enum(['available', 'unavailable', 'unknown']),
  saleRules: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('available'), rules: ProductSaleRulesSchema }),
    z.strictObject({ status: z.literal('unavailable'), error: ToolErrorSchema }),
  ]),
});
export type ProductDetails = z.infer<typeof ProductDetailsSchema>;

/** One requested line of a basket preview: what the cart holds, what would change and what it would cost. */
export const BasketPreviewLineSchema = z.strictObject({
  productId: ProductIdSchema,
  cartItemId: CartItemIdSchema.nullable(),
  name: z.string().nullable(),
  /** The desired total, in the product's sale unit; null when the sale unit is unknown. */
  requested: QuantitySchema.nullable(),
  /** What the cart holds now; zero when the product is not in it. */
  current: ObservedQuantitySchema,
  /** What `set_cart_item_quantity` would do; null when it would be refused. */
  change: z.enum(['add', 'increase', 'decrease', 'remove', 'none']).nullable(),
  availability: z.enum(['available', 'unavailable', 'unknown']).nullable(),
  price: PriceTagSchema.nullable(),
  packageText: z.string().nullable(),
  package: PackageSchema.nullable(),
  saleRules: ProductSaleRulesSchema.nullable(),
  /** Cost of the desired total at the current price; null when it cannot be worked out. */
  estimatedCost: MoneySchema.nullable(),
  /** The cost depends on the weight picked, for products sold by the piece but priced by weight. */
  estimated: z.boolean(),
  /** Why the line cannot be applied as asked, such as a quantity below the minimum. */
  error: ToolErrorSchema.nullable(),
});
export type BasketPreviewLine = z.infer<typeof BasketPreviewLineSchema>;
export const BasketPreviewSchema = z.strictObject({
  lines: z.array(BasketPreviewLineSchema),
  /** Sum of the lines' estimated costs; null when any line's cost is unknown. */
  estimatedCost: MoneySchema.nullable(),
  estimated: z.boolean(),
  /** Lines with an error or a product that is not available. */
  problems: z.number().int().nonnegative(),
});
export type BasketPreview = z.infer<typeof BasketPreviewSchema>;
