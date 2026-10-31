import { APIError, type CollectionBeforeChangeHook } from 'payload'

import { clientOf, PrintifyError } from './client'
import type { ResolvedPrintifyOptions } from './types'

/**
 * products beforeChange (pushVisibility): publishing or unpublishing a synced
 * product in Payload publishes or unpublishes it in Printify first, so the
 * Printify sales channel and the store agree. If Printify refuses (blocked,
 * locked while publishing, API error) the change is refused too. Sync writes
 * (context.printify) skip this; they copy Printify's `visible` the other way.
 */
export const pushVisibilityHook =
  (opts: ResolvedPrintifyOptions): CollectionBeforeChangeHook =>
  async ({ data, originalDoc, operation, req, context }) => {
    if (operation !== 'update' || context.printify || !opts.enabled || !opts.pushVisibility) return data
    const productId = originalDoc?.printify?.productId as string | null | undefined
    const next = data._status
    if (!productId || (next !== 'published' && next !== 'draft')) return data
    // "Save draft" on a published product also sends _status 'draft' but leaves
    // it published; only Publish/Unpublish (no ?draft=true) change visibility.
    const draft = (req.query as Record<string, unknown> | undefined)?.draft
    if (next === 'draft' && (draft === 'true' || draft === true)) return data
    const was = originalDoc?._status === 'published'
    if ((next === 'published') === was) return data

    try {
      await opts.beforePrintifyWrite?.({ action: 'visibility', doc: { ...originalDoc, ...data }, req })
    } catch (error) {
      throw new APIError(`${next === 'published' ? 'Not published' : 'Not unpublished'}: ${(error as Error).message}`, 403)
    }
    const client = clientOf(opts)
    try {
      const current = await client.product(opts.shopId!, productId)
      if (current.is_locked) throw new APIError('Printify is publishing this product; try again in a few minutes.', 409)
      if (next === 'published') await client.publish(opts.shopId!, productId)
      else await client.unpublish(opts.shopId!, productId)
    } catch (error) {
      if (error instanceof APIError) throw error
      const reason = error instanceof PrintifyError ? `Printify answered ${error.status}` : (error as Error).message
      throw new APIError(`Visibility not changed: ${reason}.`, 502)
    }
    return data
  }
