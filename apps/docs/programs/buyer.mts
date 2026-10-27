import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { x402Client, x402HTTPClient } from '@x402/core/client'
import { registerExactEvmScheme } from '@x402/evm/exact/client'
import { privateKeyToAccount } from 'viem/accounts'

type Card = { id: string; purchase_url: string; price: { amount: string } }
type Order = { order_id: string; status: string; status_url: string }
type Purchase = {
  site: string
  itemId: string
  wallet: string
  url: string
  maxUsd: string
  body: string
  paymentRequired: string
  statusUrl?: string
}

// Each file is one purchase. A different filename starts another purchase.
const FILE = process.argv[2] ?? 'purchase.json'

function syncDirectory(): void {
  const fd = openSync(dirname(FILE), 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function savedPurchase(): Purchase | undefined {
  if (!existsSync(FILE)) return undefined
  const fd = openSync(FILE, constants.O_RDWR | constants.O_NOFOLLOW)
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${FILE} is not a regular file.`)
    fchmodSync(fd, 0o600)
    const saved = JSON.parse(readFileSync(fd, 'utf8')) as Partial<Purchase> | null
    const fields = ['site', 'itemId', 'wallet', 'url', 'maxUsd', 'body', 'paymentRequired'] as const
    if (
      !saved ||
      fields.some((field) => typeof saved[field] !== 'string') ||
      (saved.statusUrl !== undefined && typeof saved.statusUrl !== 'string')
    ) {
      throw new Error('missing purchase fields')
    }
    fsyncSync(fd)
    syncDirectory()
    return saved as Purchase
  } catch {
    throw new Error(
      `Cannot read the saved purchase in ${FILE}. Keep the file; nothing will be paid.`,
    )
  } finally {
    closeSync(fd)
  }
}

function save(purchase: Purchase, first = false): void {
  const temporary = `${FILE}.${randomUUID()}.tmp`
  try {
    const fd = openSync(temporary, 'wx', 0o600)
    try {
      writeFileSync(fd, JSON.stringify(purchase))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    // Publish a complete first record without replacing another process's
    // purchase. Updates keep the previous record if writing is interrupted.
    if (first) linkSync(temporary, FILE)
    else renameSync(temporary, FILE)
    syncDirectory()
  } finally {
    rmSync(temporary, { force: true })
  }
}

// An answer is an order when it names a status and the order's address,
// whatever its HTTP status: a purchase that ended without the goods is a 409.
// Anything else is printed and read as no order.
async function orderIn(answer: Promise<Response>): Promise<Order | undefined> {
  try {
    const response = await answer
    const json = (await response.json()) as Partial<Order> | null
    if (typeof json?.status === 'string' && typeof json.status_url === 'string')
      return json as Order
    console.error(`HTTP ${response.status}: ${JSON.stringify(json)}`)
  } catch (error) {
    console.error((error as Error).message)
  }
  return undefined
}

const stopped = (order: Order, what: string) =>
  new Error(
    `Order ${order.order_id} ${what}. Its address is in ${FILE}, and the order is ` +
      'kept for the next run.',
  )

async function buy(): Promise<void> {
  if (process.argv.length > 3 || FILE.startsWith('-')) {
    throw new Error('Usage: node --env-file=.env buyer.mts [purchase-file.json]')
  }
  const { AGENTIFY_URL, BUYER_PRIVATE_KEY, ITEM_ID } = process.env
  if (!AGENTIFY_URL || !BUYER_PRIVATE_KEY || !ITEM_ID) {
    throw new Error('.env needs AGENTIFY_URL, BUYER_PRIVATE_KEY and ITEM_ID.')
  }
  const signer = privateKeyToAccount(BUYER_PRIVATE_KEY as `0x${string}`)
  const site = AGENTIFY_URL.replace(/\/+$/, '')
  let purchase = savedPurchase()
  if (
    purchase &&
    (purchase.site !== site ||
      purchase.itemId !== ITEM_ID ||
      purchase.wallet.toLowerCase() !== signer.address.toLowerCase())
  ) {
    throw new Error(
      `${FILE} belongs to another site, product or wallet. Restore its .env to resume it; use a different filename for a new purchase.`,
    )
  }
  if (!purchase) {
    const catalogue = (await (await fetch(`${site}/x402/catalog`)).json()) as { items: Card[] }
    const card = catalogue.items.find((item) => item.id === ITEM_ID)
    if (!card)
      throw new Error(
        `${ITEM_ID} is not in the catalogue. Keep the merchant's process running and polling.`,
      )
    const body = JSON.stringify({ params: { email: 'you@example.com' } })
    const asked = await fetch(card.purchase_url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    if (asked.status !== 402) throw new Error(`HTTP ${asked.status}: ${await asked.text()}`)
    const paymentRequired = asked.headers.get('payment-required')
    await asked.body?.cancel()
    if (!paymentRequired) throw new Error('No payment request came back. Nothing was paid.')
    purchase = {
      site,
      itemId: ITEM_ID,
      wallet: signer.address,
      url: card.purchase_url,
      maxUsd: card.price.amount,
      body,
      paymentRequired,
    }
    save(purchase, true)
  }

  let order: Order | undefined
  if (purchase.statusUrl) {
    order = await orderIn(fetch(purchase.statusUrl))
  } else {
    const client = new x402Client()
    registerExactEvmScheme(client, { signer, networks: ['eip155:84532'] })
    client.setSpendControls({ maxAmountPerPayment: `$${purchase.maxUsd}` })
    const payer = new x402HTTPClient(client)
    const required = payer.getPaymentRequiredResponse((name) =>
      name.toLowerCase() === 'payment-required' ? purchase.paymentRequired : null,
    )
    if (!required.accepts?.every((offer) => typeof offer.extra?.order_id === 'string')) {
      throw new Error(`${FILE} has no order to resume. Nothing was paid.`)
    }
    // A fresh signature returns an already paid order. Reusing the signature
    // that paid is refused because that signature is public on the chain.
    const payment = await payer.createPaymentPayload(required)
    order = await orderIn(
      fetch(purchase.url, {
        method: 'POST',
        body: purchase.body,
        headers: {
          'content-type': 'application/json',
          ...payer.encodePaymentSignatureHeader(payment),
        },
      }),
    )
    if (order) {
      purchase.statusUrl = order.status_url
      save(purchase)
    }
  }
  if (order === undefined) {
    throw new Error(`No order came back. Run the same command to resume the purchase in ${FILE}.`)
  }
  console.log(`Order ${order.order_id}: ${order.status}`)

  // Goods that come later are read at the order's address, every five seconds for
  // five minutes. A read that failed is printed, and reading goes on.
  for (let reads = 0; order.status === 'in_progress' && reads < 60; reads += 1) {
    await sleep(5_000)
    order = (await orderIn(fetch(order.status_url))) ?? order
  }
  // Everything the order says, the goods included, except its address.
  console.log(JSON.stringify({ ...order, status_url: undefined }, null, 2))
  if (order.status === 'in_progress') throw stopped(order, 'was not read to an end in five minutes')
  if (order.status !== 'delivered') throw stopped(order, `reads ${order.status}`)
}

await buy().catch((error: Error) => {
  console.error(
    `The purchase stopped. ${error instanceof TypeError ? 'The channel did not return a readable answer. Check AGENTIFY_URL and your connection. If the payment was sent, its outcome may be unknown; check any saved order address before buying again.' : error.message}`,
  )
  process.exitCode = 1
})
