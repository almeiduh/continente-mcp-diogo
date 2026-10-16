import { z } from 'zod';

export const QuantityUnitSchema = z.enum(['un', 'kg', 'g', 'l', 'ml']);
export type QuantityUnit = z.infer<typeof QuantityUnitSchema>;
export const QuantitySchema = z.strictObject({
  value: z.number().finite().nonnegative(),
  unit: QuantityUnitSchema,
});
export type Quantity = z.infer<typeof QuantitySchema>;

/** Raw numeric observations without established units must not become invented Quantities. */
export const ObservedQuantitySchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('known'), quantity: QuantitySchema }),
  z.strictObject({
    status: z.literal('unknown'),
    value: z.number().finite().nonnegative().nullable(),
    rawText: z.string().nullable(),
    /** Why the quantity is unknown, when the server can tell; null otherwise. */
    reason: z.enum(['missing', 'unsupported_unit', 'unrecognized_format', 'invalid_value']).nullable(),
  }),
]);
export type ObservedQuantity = z.infer<typeof ObservedQuantitySchema>;

/** Bounds are in the requested sale unit. Conversion maps sale units to storefront units. */
export const ProductSaleRulesSchema = z.strictObject({
  saleUnit: QuantityUnitSchema,
  storefrontUnit: QuantityUnitSchema,
  storefrontUnitsPerSaleUnit: z.number().finite().positive(),
  minimum: QuantitySchema.nullable(),
  maximum: QuantitySchema.nullable(),
  step: QuantitySchema.nullable(),
}).superRefine((rules, context) => {
  for (const key of ['minimum', 'maximum', 'step'] as const) {
    const bound = rules[key];
    if (bound && bound.unit !== rules.saleUnit) {
      context.addIssue({ code: 'custom', path: [key, 'unit'], message: 'Bound must use the sale unit' });
    }
  }
  if (rules.step?.value === 0) {
    context.addIssue({ code: 'custom', path: ['step'], message: 'Step must be positive' });
  }
  if (rules.minimum && rules.maximum && rules.minimum.value > rules.maximum.value) {
    context.addIssue({ code: 'custom', path: ['maximum'], message: 'Maximum must not be below minimum' });
  }
  if (rules.saleUnit === rules.storefrontUnit && rules.storefrontUnitsPerSaleUnit !== 1) {
    context.addIssue({ code: 'custom', path: ['storefrontUnitsPerSaleUnit'], message: 'Same-unit conversion must be identity' });
  }
});
export type ProductSaleRules = z.infer<typeof ProductSaleRulesSchema>;
