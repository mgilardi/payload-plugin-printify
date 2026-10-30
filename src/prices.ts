import { APIError, type CollectionAfterChangeHook, type CollectionBeforeChangeHook, type CollectionSlug } from 'payload'

import { clientOf, PrintifyError } from './client'
import type { ResolvedPrintifyOptions } from './types'

const idOf = (v: unknown) => (v && typeof v === 'object' ? String((v as { id: unknown }).id) : v ? String(v) : '')
// No context here: with `req`, a nested call's context is merged into the
// request's, and context.printify would mark the editor's own save as a sync.
const trusted = { overrideAccess: true } as const

/**
 * variants beforeChange (pushPrices): a price edited in Payload on a synced
 * variant is written to the Printify product first; if Printify refuses
 * (blocked, product locked while publishing, API error) the edit is refused
 * too, so the two never disagree. Sync writes (context.printify) skip this.
 */
export const pushVariantPriceHook =
  (opts: ResolvedPrintifyOptions): CollectionBeforeChangeHook =>
  async ({ data, originalDoc, operation, req, context }) => {
    if (operation !== 'update' || context.printify || !opts.enabled || !opts.pushPrices) return data
    const field = `priceIn${opts.currency}`
    const price = data[field]
    const variantId = originalDoc?.printify?.variantId as number | null | undefined
    if (variantId == null || typeof price !== 'number' || price === originalDoc?.[field]) return data
    if (!Number.isInteger(price) || price <= 0) throw new APIError('Printify prices are whole cents above zero.', 400)

    const product = (await req.payload.findByID({
      collection: opts.collections.products as CollectionSlug,
      id: idOf(originalDoc?.product ?? data.product),
      depth: 0,
      draft: true,
      req,
      ...trusted,
    })) as { printify?: { productId?: string | null } }
    const productId = product?.printify?.productId
    if (!productId) return data

    try {
      await opts.beforePrintifyWrite?.({ action: 'price', doc: { ...originalDoc, ...data }, req })
    } catch (error) {
      throw new APIError(`Price not changed: ${(error as Error).message}`, 403)
    }
    const client = clientOf(opts)
    try {
      const current = await client.product(opts.shopId!, productId)
      if (current.is_locked) throw new APIError('Printify is publishing this product; try again in a few minutes.', 409)
      if (!current.variants.some((v) => v.id === variantId)) throw new APIError('Printify no longer has this variant.', 409)
      // Printify replaces the variant list: send every variant, changing one price.
      await client.updateProduct(opts.shopId!, productId, {
        variants: current.variants.map((v) => ({ id: v.id, price: v.id === variantId ? price : v.price, is_enabled: v.is_enabled })),
      })
    } catch (error) {
      if (error instanceof APIError) throw error
      const reason = error instanceof PrintifyError ? `Printify answered ${error.status}` : (error as Error).message
      throw new APIError(`Price not changed: ${reason}.`, 502)
    }
    return data
  }

/** variants afterChange: keep the product's "from" price (lowest published variant) current after an edit. */
export const productFromPriceHook =
  (opts: ResolvedPrintifyOptions): CollectionAfterChangeHook =>
  async ({ doc, previousDoc, req, context }) => {
    const field = `priceIn${opts.currency}`
    if (context.printify || !opts.enabled || doc.printify?.variantId == null || doc[field] === previousDoc?.[field]) return doc
    const product = idOf(doc.product)
    const { docs } = await req.payload.find({
      collection: opts.collections.variants as CollectionSlug,
      where: { and: [{ product: { equals: product } }, { _status: { equals: 'published' } }] },
      limit: 500,
      depth: 0,
      req,
      ...trusted,
    })
    const prices = (docs as unknown as Record<string, unknown>[]).map((v) => v[field]).filter((p): p is number => typeof p === 'number')
    if (prices.length)
      await req.payload.update({
        collection: opts.collections.products as CollectionSlug,
        id: product,
        data: { [field]: Math.min(...prices) } as never,
        req,
        ...trusted,
      })
    return doc
  }
