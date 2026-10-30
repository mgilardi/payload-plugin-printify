import type { CollectionSlug, Payload, Where } from 'payload'

import type { PrintifyProduct } from './client'
import type { ResolvedPrintifyOptions } from './types'

/** Printify descriptions are HTML; shops get plain paragraphs. */
export const plainText = (html: string) =>
  html
    .replace(/<\s*(br|\/p|\/li|\/h\d)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

export const slugify = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'product'

/** The parts of a Printify product a store keeps (pure). Prices stay in cents. */
export function mapPrintifyProduct(p: PrintifyProduct) {
  const enabled = p.variants.filter((v) => v.is_enabled)
  const usedValues = new Set(enabled.flatMap((v) => v.options))
  const options = p.options
    .map((o) => ({
      name: slugify(o.name),
      label: o.name,
      values: o.values.filter((v) => usedValues.has(v.id)).map((v) => ({ value: String(v.id), label: v.title })),
    }))
    .filter((o) => o.values.length > 0)
  const prices = enabled.map((v) => v.price)
  return {
    title: p.title,
    description: plainText(p.description ?? ''),
    published: p.visible !== false && enabled.length > 0,
    minPrice: prices.length ? Math.min(...prices) : null,
    images: [...p.images]
      .sort((a, b) => Number(b.is_default) - Number(a.is_default))
      .slice(0, 20)
      .map((i) => ({ url: i.src, alt: p.title, variantIds: i.variant_ids, isDefault: i.is_default })),
    options,
    variants: enabled.map((v) => ({
      printifyId: v.id,
      sku: v.sku ?? null,
      title: v.title,
      price: v.price,
      available: v.is_available !== false,
      optionValues: v.options.map(String),
    })),
  }
}

type Doc = Record<string, unknown> & { id: string | number }
const write = { overrideAccess: true, context: { disableRevalidate: true, audit: false, printify: true } } as const

/** Store operations scoped to the configured tenant (if any). */
export function storeScope(payload: Payload, opts: ResolvedPrintifyOptions, tenantId: string | number | null) {
  const field = opts.tenant?.field ?? 'tenant'
  const scoped = (where: Where): Where => (tenantId == null ? where : { and: [{ [field]: { equals: tenantId } }, where] })
  const withTenant = <T extends object>(data: T) => (tenantId == null ? data : { ...data, [field]: tenantId })
  const c = (k: keyof ResolvedPrintifyOptions['collections']) => opts.collections[k] as CollectionSlug
  const findOne = async (k: keyof ResolvedPrintifyOptions['collections'], where: Where) =>
    (await payload.find({ collection: c(k), where: scoped(where), limit: 1, depth: 0, draft: true, ...write })).docs[0] as unknown as Doc | undefined
  return { scoped, withTenant, c, findOne }
}

/**
 * Create or update the store product (with variant types, options and
 * variants) for a Printify product. Variants Printify no longer offers become
 * drafts. Returns the store product's id and slug.
 */
export async function syncPrintifyProduct(payload: Payload, opts: ResolvedPrintifyOptions, tenantId: string | number | null, p: PrintifyProduct) {
  const m = mapPrintifyProduct(p)
  const { scoped, withTenant, c, findOne } = storeScope(payload, opts, tenantId)

  const optionIds = new Map<string, string>()
  const typeIds: string[] = []
  for (const o of m.options) {
    const type =
      (await findOne('variantTypes', { name: { equals: o.name } })) ??
      ((await payload.create({ collection: c('variantTypes'), data: withTenant({ name: o.name, label: o.label }) as never, ...write })) as unknown as Doc)
    typeIds.push(String(type.id))
    for (const v of o.values) {
      const opt =
        (await findOne('variantOptions', { and: [{ variantType: { equals: type.id } }, { value: { equals: v.value } }] })) ??
        ((await payload.create({ collection: c('variantOptions'), data: withTenant({ variantType: type.id, value: v.value, label: v.label }) as never, ...write })) as unknown as Doc)
      optionIds.set(v.value, String(opt.id))
    }
  }

  const existing = await findOne('products', { 'printify.productId': { equals: p.id } })
  let slug = (existing?.slug as string | undefined) ?? slugify(m.title)
  if (!existing) for (let i = 2; await findOne('products', { slug: { equals: slug } }); i++) slug = `${slugify(m.title)}-${i}`
  // Publishing state is written on the document itself (not as a draft version).
  const price = `priceIn${opts.currency}`
  const data = withTenant({
    title: m.title,
    slug,
    generateSlug: false,
    description: m.description,
    images: m.images,
    enableVariants: m.options.length > 0,
    variantTypes: typeIds,
    [`${price}Enabled`]: m.minPrice != null,
    [price]: m.minPrice,
    printify: {
      productId: p.id,
      shopId: String(opts.shopId),
      blueprintId: p.blueprint_id,
      printProviderId: p.print_provider_id,
      syncedAt: new Date().toISOString(),
    },
    _status: m.published ? 'published' : 'draft',
  })
  const product = (
    existing
      ? await payload.update({ collection: c('products'), id: existing.id, data: data as never, ...write })
      : await payload.create({ collection: c('products'), data: data as never, ...write })
  ) as unknown as Doc

  const current = (
    await payload.find({ collection: c('variants'), where: scoped({ product: { equals: product.id } }), limit: 500, depth: 0, draft: true, ...write })
  ).docs as unknown as (Doc & { printify?: { variantId?: number | null } | null; _status?: string | null })[]
  const byPrintifyId = new Map(current.map((v) => [v.printify?.variantId, v]))
  const offered = new Set<number>()
  for (const v of m.variants) {
    offered.add(v.printifyId)
    const vdata = withTenant({
      product: product.id,
      title: v.title,
      options: v.optionValues.map((o) => optionIds.get(o)).filter(Boolean),
      [`${price}Enabled`]: true,
      [price]: v.price,
      printify: { variantId: v.printifyId, sku: v.sku },
      _status: m.published && v.available ? 'published' : 'draft',
    })
    const old = byPrintifyId.get(v.printifyId)
    if (old) await payload.update({ collection: c('variants'), id: old.id, data: vdata as never, ...write })
    else await payload.create({ collection: c('variants'), data: vdata as never, ...write })
  }
  for (const old of current)
    if (old.printify?.variantId != null && !offered.has(old.printify.variantId) && old._status !== 'draft')
      await payload.update({ collection: c('variants'), id: old.id, data: { _status: 'draft' } as never, ...write })

  return { id: String(product.id), slug }
}

/** Printify deleted or unpublished a product: hide the store copy (kept for order history). */
export async function unpublishPrintifyProduct(payload: Payload, opts: ResolvedPrintifyOptions, tenantId: string | number | null, printifyId: string) {
  const { c, findOne } = storeScope(payload, opts, tenantId)
  const found = await findOne('products', { 'printify.productId': { equals: printifyId } })
  if (found) await payload.update({ collection: c('products'), id: found.id, data: { _status: 'draft' } as never, ...write })
  return Boolean(found)
}
