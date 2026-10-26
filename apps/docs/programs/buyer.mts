import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { x402Client, x402HTTPClient } from '@x402/core/client'
import type { PaymentPayload, PaymentRequired } from '@x402/core/types'
import { registerExactEvmScheme } from '@x402/evm/exact/client'
import { privateKeyToAccount } from 'viem/accounts'

// The test channel's chain, Base Sepolia. The buyer signs for no other; the
// live channel's chain is Base, eip155:8453.
const NETWORK = 'eip155:84532'

// Everything needed to take this purchase up again, written before the
// payment is sent: the payment request, the payment signed for it and the
// order's address, which carries the buyer's key, so the file is kept to
// yourself like the key. While it exists, a run takes this purchase up again
// instead of buying again; delete it to buy again.
const KEPT = 'purchase.json'

// How often, and how many times, one run reads an order that is not finished.
const WAIT_MS = 5_000
const READS = 60

type Card = { id: string; purchase_url: string; price: { amount: string } }
type Order = { order_id: string; status: string; status_url: string; delivered: unknown }
type Kept = {
  card: Card
  body: string
  challenge: PaymentRequired
  payment?: PaymentPayload
  status_url?: string
}

// What a call came back with: its JSON, or why there is none, said in full.
type Answer = { json: unknown } | { failed: string }

async function call(url: string, init?: RequestInit): Promise<Answer> {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    return { failed: `no answer from ${url}: ${(error as Error).message}` }
  }
  const text = await response.text()
  if (!response.ok) return { failed: `HTTP ${response.status} from ${url}: ${text}` }
  try {
    return { json: JSON.parse(text) }
  } catch {
    return { failed: `HTTP ${response.status} from ${url}, not JSON: ${text}` }
  }
}

// An order is an answer that names its status and where it is read again.
// Anything else, a refusal included, is not one.
const orderIn = (answer: Answer): Order | undefined => {
  if (!('json' in answer)) return undefined
  const order = answer.json as Partial<Order> | null
  return typeof order?.status === 'string' && typeof order.status_url === 'string'
    ? (order as Order)
    : undefined
}
const said = (answer: Answer): string =>
  'failed' in answer ? answer.failed : JSON.stringify(answer.json)

const keep = (kept: Kept) => writeFileSync(KEPT, `${JSON.stringify(kept, null, 2)}\n`)

const buyer = privateKeyToAccount(process.env.BUYER_PRIVATE_KEY as `0x${string}`)

// A payer that signs only on the channel's chain and never more than the
// card's own price, so a payment request that asks for another chain or for
// more is refused before anything is signed.
function payerFor(card: Card): x402HTTPClient {
  const client = new x402Client()
  registerExactEvmScheme(client, { signer: buyer, networks: [NETWORK] })
  client.setSpendControls({ maxAmountPerPayment: `$${card.price.amount}` })
  return new x402HTTPClient(client)
}

// Asks to buy your card, by the id step 3 returned, and returns the payment
// request the answer names. Nothing is charged yet.
async function askToBuy(): Promise<Omit<Kept, 'payment'> | string> {
  const listed = await call(`${process.env.AGENTIFY_URL}/x402/catalog`)
  if ('failed' in listed) return `The catalogue could not be read: ${listed.failed}`
  const items = (listed.json as { items?: Card[] }).items ?? []
  const card = items.find((item) => item.id === process.env.ITEM_ID)
  if (card === undefined) return `${process.env.ITEM_ID} is not in the catalogue.`

  const body = JSON.stringify({ params: { email: 'you@example.com' } })
  const asked = await fetch(card.purchase_url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
  if (asked.status !== 402) {
    return `Asked to buy, the answer was HTTP ${asked.status}: ${await asked.text()}`
  }
  await asked.body?.cancel()
  const challenge = payerFor(card).getPaymentRequiredResponse((name) => asked.headers.get(name))
  return { card, body, challenge }
}

// Signs the kept payment request and sends the purchase again with it. The
// request and the payment are kept before they are sent. On a first run this
// pays; on a run after a lost answer, a fresh signature for the same request
// from the same wallet returns the order with no second charge.
async function pay(kept: Kept): Promise<Order | string> {
  const payer = payerFor(kept.card)
  try {
    kept.payment = await payer.createPaymentPayload(kept.challenge)
  } catch (error) {
    const asked = kept.challenge.accepts.map((each) => `${each.amount} on ${each.network}`)
    return `The payment request (${asked.join(', ')}) was not signed: ${(error as Error).message}`
  }
  keep(kept)
  const paid = await call(kept.card.purchase_url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...payer.encodePaymentSignatureHeader(kept.payment),
    },
    body: kept.body,
  })
  const order = orderIn(paid)
  if (order === undefined) {
    return (
      `The answer to the payment is not an order: ${said(paid)}\n` +
      `Run this again to sign the kept payment request again: a paid order comes ` +
      `back with no second charge, and a refusal comes back as it is.`
    )
  }
  kept.status_url = order.status_url
  keep(kept)
  console.log(`Order ${order.order_id}: ${order.status}. Its address is kept in ${KEPT}.`)
  return order
}

async function buy(): Promise<number> {
  let kept: Kept
  if (existsSync(KEPT)) {
    kept = JSON.parse(readFileSync(KEPT, 'utf8')) as Kept
    console.log(`Taking up the purchase kept in ${KEPT}.`)
  } else {
    const asked = await askToBuy()
    if (typeof asked === 'string') {
      console.error(asked)
      return 1
    }
    kept = asked
  }

  let order: Order | undefined
  if (kept.status_url === undefined) {
    const paid = await pay(kept)
    if (typeof paid === 'string') {
      console.error(paid)
      return 1
    }
    order = paid
  }

  // Goods that come later are collected at the order's own address. A read
  // that fails says nothing about the order, so it is reported and read again.
  for (let reads = 0; order === undefined || order.status === 'in_progress'; reads += 1) {
    if (reads === READS) {
      const last = order === undefined ? 'no read answered' : `it read ${order.status}`
      console.error(
        `The order has not finished after ${READS} reads (${last}). ` +
          `Run this again to go on reading it at the address kept in ${KEPT}.`,
      )
      return 1
    }
    if (reads > 0 || order !== undefined) await sleep(WAIT_MS)
    const read = await call(kept.status_url as string)
    const latest = orderIn(read)
    if (latest === undefined) console.error(`The order could not be read: ${said(read)}`)
    else order = latest
  }

  console.log(`${order.status}: ${JSON.stringify(order.delivered)}`)
  console.log(`The purchase stays in ${KEPT}; delete it to buy again.`)
  return order.status === 'delivered' ? 0 : 1
}

process.exitCode = await buy()
