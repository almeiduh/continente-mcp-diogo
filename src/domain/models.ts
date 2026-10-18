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
export const FavoriteProductSchema = ProductReferenceSchema.safeExtend(productDetails);
export type FavoriteProduct = z.infer<typeof FavoriteProductSchema>;
export const ProductSchema = FavoriteProductSchema.safeExtend({
  /** The comparison price shown next to the main one, such as per kg or per piece. */
  secondaryPrice: PriceTagSchema.nullable(),
  /** Pack size as displayed, such as `940 gr`, `2 x 52 gr` or `1,2 kg (aprox.)`. */
  packageText: z.string().nullable(),
  /** The recommended retail price (PVPR) shown beside a promotional price; null when the website shows none. */
  recommendedPrice: PriceTagSchema.nullable(),
  minimumText: z.string().nullable(),
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
});
export type CartTotals = z.infer<typeof CartTotalsSchema>;
export const CheckoutSummarySchema = z.strictObject({
  stage: z.literal('basket'), provisional: z.literal(true), totals: CartTotalsSchema,
  immediateDiscounts: MoneySchema.nullable(), loyaltyCredit: MoneySchema.nullable(),
  selectedCouponIds: z.array(z.string().trim().min(1).max(200)).nullable(),
});
export type CheckoutSummary = z.infer<typeof CheckoutSummarySchema>;
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
  secondaryPrice: PriceTagSchema.nullable(), recommendedPrice: PriceTagSchema.nullable(), availability: z.enum(['available', 'unavailable', 'unknown']),
  saleRules: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('available'), rules: ProductSaleRulesSchema }),
    z.strictObject({ status: z.literal('unavailable'), error: ToolErrorSchema }),
  ]),
});
export type ProductDetails = z.infer<typeof ProductDetailsSchema>;

/** A coupon as displayed on the account's coupon page. Unknown retailer rules remain unknown. */
export const CouponSchema = z.strictObject({
  couponId: z.string().trim().min(1).max(200).nullable(),
  description: z.string().trim().min(1).max(1000),
  availability: z.string().trim().max(300).nullable(),
  benefitValue: z.string().trim().max(100).nullable(),
  benefitQualifier: z.string().trim().max(200).nullable(),
  eligibility: z.literal('unknown'),
  expiry: z.null(),
});
export type Coupon = z.infer<typeof CouponSchema>;
export const CouponListSchema = z.strictObject({ coupons: z.array(CouponSchema), completeness: z.enum(['complete', 'partial', 'unknown']) });
export type CouponList = z.infer<typeof CouponListSchema>;
export const CouponSelectionSchema = z.strictObject({
  outcome: z.enum(['confirmed', 'unknown']), selectedCouponIds: z.array(z.string().trim().min(1).max(200)),
});
export type CouponSelection = z.infer<typeof CouponSelectionSchema>;

export const PickupStoreSchema = z.strictObject({
  storeId: z.string().trim().min(1).max(100), name: z.string().trim().min(1).max(250),
  address1: z.string().trim().max(250).nullable(), address2: z.string().trim().max(250).nullable(),
  city: z.string().trim().max(150).nullable(), postalCode: z.string().trim().max(20).nullable(),
  latitude: z.number().finite().nullable(), longitude: z.number().finite().nullable(),
  countryCode: z.string().trim().max(10).nullable(), storeHours: z.unknown().nullable(),
  isPickupStore: z.boolean(), isGalpStore: z.boolean().nullable(),
});
export type PickupStore = z.infer<typeof PickupStoreSchema>;
export const PickupStoresSchema = z.strictObject({ stores: z.array(PickupStoreSchema), completeness: z.enum(['complete', 'partial', 'unknown']), selectedStoreChanged: z.literal(false) });
export type PickupStores = z.infer<typeof PickupStoresSchema>;
export const PickupSlotSchema = z.strictObject({
  date: z.iso.date(), weekday: z.string().trim().max(40).nullable(), weekdayShort: z.string().trim().max(20).nullable(),
  startTime: z.string().trim().max(20).nullable(), endTime: z.string().trim().max(20).nullable(), shippingCost: z.string().trim().max(40).nullable(),
});
export const PickupSlotsSchema = z.strictObject({
  pickupMode: z.enum(['pickup', 'unknown']), selectedStoreId: z.string().trim().min(1).max(100).nullable(), storePostalCode: z.string().trim().max(20).nullable(),
  dateWindow: z.strictObject({ from: z.iso.date(), to: z.iso.date() }), dateYearBasis: z.literal('requested-window'),
  coverage: z.literal('server-rendered-days-only'),
  slots: z.array(PickupSlotSchema), completeness: z.enum(['complete', 'partial', 'unknown']),
  selectedStoreChanged: z.literal(false), slotReserved: z.literal(false),
});
export type PickupSlot = z.infer<typeof PickupSlotSchema>;
export type PickupSlots = z.infer<typeof PickupSlotsSchema>;
export const PickupStoreChangeSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('confirmed'), requestedStoreId: z.string().trim().min(1).max(100),
    previousStoreId: z.string().trim().min(1).max(100), selectedStoreId: z.string().trim().min(1).max(100),
    storeName: z.string().trim().max(250).nullable(), storePostalCode: z.string().trim().max(20).nullable(),
    selectedStoreChanged: z.boolean(), cartAndCouponsNeedRevalidation: z.boolean() }),
  z.strictObject({ outcome: z.literal('not_applied'), requestedStoreId: z.string().trim().min(1).max(100),
    previousStoreId: z.string().trim().min(1).max(100), selectedStoreId: z.string().trim().min(1).max(100),
    storeName: z.string().trim().max(250).nullable(), storePostalCode: z.string().trim().max(20).nullable(),
    selectedStoreChanged: z.literal(false), cartAndCouponsNeedRevalidation: z.literal(false) }),
  z.strictObject({ outcome: z.literal('unknown'), requestedStoreId: z.string().trim().min(1).max(100),
    previousStoreId: z.string().trim().min(1).max(100), selectedStoreId: z.string().trim().min(1).max(100).nullable(),
    storeName: z.string().trim().max(250).nullable(), storePostalCode: z.string().trim().max(20).nullable(),
    selectedStoreChanged: z.boolean().nullable(), cartAndCouponsNeedRevalidation: z.literal(true),
    recovery: z.strictObject({ action: z.literal('list_pickup_slots'), fromDate: z.iso.date(), toDate: z.iso.date(), automaticReplay: z.literal(false) }) }),
]);
export type PickupStoreChange = z.infer<typeof PickupStoreChangeSchema>;
