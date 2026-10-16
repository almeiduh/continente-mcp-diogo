import { z } from 'zod';
import { MoneySchema } from './money.js';
import type { Money } from './money.js';

/**
 * EntregaZero, Continente's delivery subscription, makes delivery free on orders of at least this
 * much (https://www.continente.pt/loja-online/ajuda/entregazero/existe-valor-minimo-de-compra-para-utilizar-o-servico-entregazero/).
 * The cart does not give it, so the weekly site check confirms the help page still says so.
 */
export const ENTREGA_ZERO_FREE_FROM: Money = { currency: 'EUR', minorUnits: 5000 };

/** What checkout adds or requires beyond the cart's lines, compared with the products total. */
export const CheckoutSchema = z.strictObject({
  /** The website's minimum order value, as the cart states it; null when it does not. */
  minimumOrder: MoneySchema.nullable(),
  /** Whether the products total reaches the minimum order; null when either is unknown. */
  meetsMinimum: z.boolean().nullable(),
  /** Whether the account has an active EntregaZero subscription; null when signed out or not stated. */
  entregaZero: z.boolean().nullable(),
  /** With EntregaZero, delivery is free from this products total; null without it. */
  freeDeliveryFrom: MoneySchema.nullable(),
  /**
   * `free`: EntregaZero applies to this products total. `set_at_checkout`: the fee depends on the
   * day, time slot and area chosen at checkout, and is not in the totals until then.
   */
  deliveryFee: z.enum(['free', 'set_at_checkout']),
});
export type Checkout = z.infer<typeof CheckoutSchema>;

export function checkoutFor(products: Money | null, minimumOrder: Money | null, entregaZero: boolean | null): Checkout {
  const freeDeliveryFrom = entregaZero === true ? ENTREGA_ZERO_FREE_FROM : null;
  return {
    minimumOrder,
    meetsMinimum: products && minimumOrder ? products.minorUnits >= minimumOrder.minorUnits : null,
    entregaZero,
    freeDeliveryFrom,
    deliveryFee: freeDeliveryFrom && products && products.minorUnits >= freeDeliveryFrom.minorUnits ? 'free' : 'set_at_checkout',
  };
}
