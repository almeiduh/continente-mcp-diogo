import { z } from 'zod';
import { ToolErrorSchema } from './errors.js';
import { ProductIdSchema, CartItemIdSchema } from './identity.js';
import { QuantitySchema } from './quantity.js';

const mutation = { productId: ProductIdSchema, requested: QuantitySchema };
export const CartMutationResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    ...mutation, outcome: z.literal('confirmed'), confirmedQuantity: QuantitySchema,
    /** The cart line changed, when the call named one; null otherwise. */
    cartItemId: CartItemIdSchema.nullable(),
    /** For a removal: whether the product was removed or was not in the cart; null for other changes. */
    disposition: z.enum(['removed', 'already_absent']).nullable(),
  }),
  z.strictObject({
    ...mutation, outcome: z.literal('not_applied'), error: ToolErrorSchema,
  }),
  z.strictObject({
    ...mutation, outcome: z.literal('unknown'),
    error: ToolErrorSchema.extend({ retryable: z.literal(false) }),
    recovery: z.strictObject({ action: z.literal('get_cart'), automaticReplay: z.literal(false) }),
  }),
]).refine(result => result.outcome !== 'confirmed' || result.confirmedQuantity.unit === result.requested.unit,
{ message: 'Confirmed and requested quantities must use the same sale unit' });
export type CartMutationResult = z.infer<typeof CartMutationResultSchema>;
/** Emptying the cart: confirmed by reading it back, or unknown when it could not be confirmed. */
export const ClearCartResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('confirmed'), disposition: z.enum(['cleared', 'already_empty']),
    /** Product lines the cart held before; bags are not counted. */
    removedLines: z.number().int().nonnegative() }),
  z.strictObject({ outcome: z.literal('unknown'), error: ToolErrorSchema.extend({ retryable: z.literal(false) }),
    recovery: z.strictObject({ action: z.literal('get_cart'), automaticReplay: z.literal(false) }) }),
]);
export type ClearCartResult = z.infer<typeof ClearCartResultSchema>;

/** Completeness is about the requested source scope, not the entire shop or account history. */
export function pageResultSchema<T extends z.ZodType>(item: T) {
  return z.strictObject({
    items: z.array(item),
    completeness: z.enum(['complete', 'partial', 'unknown']),
    failures: z.array(ToolErrorSchema),
    nextCursor: z.string().min(1).nullable(),
  }).superRefine((page, context) => {
    if (page.completeness === 'complete' && (page.failures.length > 0 || page.nextCursor !== null)) {
      context.addIssue({ code: 'custom', message: 'Complete results cannot have failures or remaining pages' });
    }
    if (page.completeness === 'partial' && page.failures.length === 0) {
      context.addIssue({ code: 'custom', path: ['failures'], message: 'Partial results must explain the failure' });
    }
    if (page.failures.length > 0 && page.completeness !== 'partial') {
      context.addIssue({ code: 'custom', path: ['completeness'], message: 'Failures must be reported as partial' });
    }
  });
}
export type PageResult<T> = z.infer<ReturnType<typeof pageResultSchema<z.ZodType<T>>>>;
