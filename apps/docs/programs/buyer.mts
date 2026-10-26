import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { x402Client, x402HTTPClient } from '@x402/core/client'
import type { PaymentPayload, PaymentRequired } from '@x402/core/types'
import { registerExactEvmScheme } from '@x402/evm/exact/client'
import { formatUnits } from 'viem'
import { type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts'

// The test channel's chain, Base Sepolia. The buyer signs for no other; the
// live channel's chain is Base, eip155:8453.
const NETWORK = 'eip155:84532'

// Everything needed to take this purchase up again, written before the
// payment is sent: the payment request, the payment signed for it and the
// order's address, which carries the buyer's key. While the file exists, a run
// takes this purchase up again instead of buying again.
const KEPT = 'purchase.json'

// How often, and how many times, one run reads an order that is not finished.
const WAIT_MS = 5_000
const READS = 60

// The words an order reads while it can still change without the buyer: not
// finished, or finished with nobody yet knowing whether the charge went through.
const STILL_MOVING = ['in_progress', 'payment_unresolved']

type Card = { id: string; purchase_url: string; price: { amount: string; currency: string } }
type Order = {
  order_id: string
  status: string
  status_url: string
  payment_status?: string
  reason?: string
  refusal?: { code: string; message: string }
  delivered: unknown
}
type Kept = {
  card: Card
  body: string
  challenge: PaymentRequired
  payment?: PaymentPayload
  status_url?: string
}

// What a call came back with: its JSON, whatever the status code, or why there
// is none. `what` names the address in what is printed, because the order's
// address is a key and is never printed.
type Answer = { status: number; json: unknown } | { failed: string }

async function call(url: string, what: string, init?: RequestInit): Promise<Answer> {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    return { failed: `${what} did not answer: ${(error as Error).message}` }
  }
  const text = await response.text()
  try {
    return { status: response.status, json: JSON.parse(text) }
  } catch {
    return { failed: `${what} answered HTTP ${response.status}, not JSON: ${text}` }
  }
}

// An order is an answer that names its status and its address, whatever HTTP
// status it came with: a purchase that ended without the goods is answered
// with the order and 409.
const orderIn = (answer: Answer): Order | undefined => {
  if (!('json' in answer)) return undefined
  const order = answer.json as Partial<Order> | null
  return typeof order?.status === 'string' && typeof order.status_url === 'string'
    ? (order as Order)
    : undefined
}

// A refusal names its code, its words, and whether the same call could succeed.
type Refusal = { code: string; message: string; retryable: boolean }
const refusalIn = (answer: Answer): Refusal | undefined => {
  if (!('json' in answer)) return undefined
  const refusal = (answer.json as { error?: Partial<Refusal> } | null)?.error
  return typeof refusal?.code === 'string' ? (refusal as Refusal) : undefined
}

const said = (answer: Answer): string => {
  if ('failed' in answer) return answer.failed
  const refusal = refusalIn(answer)
  return refusal === undefined
    ? `HTTP ${answer.status}: ${JSON.stringify(answer.json)}`
    : `HTTP ${answer.status}, ${refusal.code}: ${refusal.message}`
}

// The file holds the order's key and a signed payment, so only its owner reads it.
const keep = (kept: Kept) =>
  writeFileSync(KEPT, `${JSON.stringify(kept, null, 2)}\n`, { mode: 0o600 })

// A payer that signs only on the channel's chain and never more than the
// card's own price, so a payment request that asks for another chain or for
// more is refused before anything is signed.
function payerFor(card: Card, buyer: PrivateKeyAccount): x402HTTPClient {
  const client = new x402Client()
  registerExactEvmScheme(client, { signer: buyer, networks: [NETWORK] })
  client.setSpendControls({ maxAmountPerPayment: `$${card.price.amount}` })
  return new x402HTTPClient(client)
}

// Asks to buy your card, by the id step 3 returned, and returns the payment
// request the answer names. Nothing is charged yet.
async function askToBuy(buyer: PrivateKeyAccount): Promise<Kept | string> {
  const listed = await call(`${process.env.AGENTIFY_URL}/x402/catalog`, 'The catalogue')
  if ('failed' in listed) return `The catalogue could not be read. ${listed.failed}`
  const items = (listed.json as { items?: Card[] }).items ?? []
  const card = items.find((item) => item.id === process.env.ITEM_ID)
  if (card === undefined) return `${process.env.ITEM_ID} is not in the catalogue.`

  const body = JSON.stringify({ params: { email: 'you@example.com' } })
  let asked: Response
  try {
    asked = await fetch(card.purchase_url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
  } catch (error) {
    return `The purchase address did not answer: ${(error as Error).message}`
  }
  if (asked.status !== 402) {
    return `Asked to buy, the answer was HTTP ${asked.status}: ${await asked.text()}`
  }
  await asked.body?.cancel()
  try {
    const payer = payerFor(card, buyer)
    return {
      card,
      body,
      challenge: payer.getPaymentRequiredResponse((name) => asked.headers.get(name)),
    }
  } catch (error) {
    return `The answer carried no payment request that could be read: ${(error as Error).message}`
  }
}

// Who signed a payment: the wallet its authorisation is from.
const signerOf = (payment: PaymentPayload): string | undefined =>
  (payment.payload as { authorization?: { from?: string } }).authorization?.from

// Signs the kept payment request and sends the purchase again with it. The
// request and the payment are kept before they are sent. On a first run this
// pays; afterwards a fresh signature for the same request from the same wallet
// returns the order with no second charge.
async function pay(kept: Kept, buyer: PrivateKeyAccount): Promise<Order | string> {
  // Only the first payment of a purchase with no order yet can end it: after
  // that, the order may already be paid or hold goods made for it.
  const first = kept.payment === undefined && kept.status_url === undefined
  const before = kept.payment === undefined ? undefined : signerOf(kept.payment)
  if (before !== undefined && before.toLowerCase() !== buyer.address.toLowerCase()) {
    return (
      `This purchase was signed by ${before}, and BUYER_PRIVATE_KEY signs for ` +
      `${buyer.address}. Only the wallet that signed it gets it back: put that key ` +
      `back in .env and run this again.`
    )
  }
  const payer = payerFor(kept.card, buyer)
  try {
    kept.payment = await payer.createPaymentPayload(kept.challenge)
  } catch (error) {
    // USDC, which every Agentify price is paid in, counts in millionths.
    const asked = kept.challenge.accepts.map(
      (each) => `${formatUnits(BigInt(each.amount), 6)} USDC on ${each.network}`,
    )
    return (
      `The payment request (${asked.join(', ')}) was not signed; the card's price is ` +
      `${kept.card.price.amount} ${kept.card.price.currency}. ${(error as Error).message}`
    )
  }
  keep(kept)
  const paid = await call(kept.card.purchase_url, 'The purchase address', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...payer.encodePaymentSignatureHeader(kept.payment),
    },
    body: kept.body,
  })

  const order = orderIn(paid)
  if (order !== undefined) {
    kept.status_url = order.status_url
    keep(kept)
    console.log(`Order ${order.order_id}. Its address is kept in ${KEPT}.`)
    return order
  }
  const refusal = refusalIn(paid)
  if (refusal !== undefined && !refusal.retryable && first) {
    return (
      `The payment was refused and this purchase is over. ${said(paid)}\n` +
      `Delete ${KEPT} to start a new purchase.`
    )
  }
  if (refusal !== undefined && !refusal.retryable) {
    return (
      `The payment was refused. ${said(paid)}\n` +
      `Keep ${KEPT}: this purchase may already be paid, or hold goods made for it. ` +
      `Fix what the refusal names and run this again.`
    )
  }
  return (
    `The answer to the payment is not an order. ${said(paid)}\n` +
    `Run this again: it signs the kept payment request again, which returns a ` +
    `paid order with no second charge.`
  )
}

// What an order that will not change by itself says to the person running this.
function ended(order: Order): number {
  const why = order.refusal ? `${order.refusal.code}: ${order.refusal.message}` : order.reason
  console.log(`Order ${order.order_id}: ${order.status}${why ? ` (${why})` : ''}`)
  if (order.status === 'delivered') {
    console.log(JSON.stringify(order.delivered, null, 2))
    console.log(`Delete ${KEPT} once you no longer need it, and to buy again.`)
    return 0
  }
  if (order.payment_status === 'not_paid') {
    console.log(`Nothing was charged. Delete ${KEPT} to buy again.`)
  } else {
    console.log(
      `The goods have not come and the payment reads ${order.payment_status}. ` +
        `Keep ${KEPT}: running this again reads the order again.`,
    )
  }
  return 1
}

async function buy(): Promise<number> {
  const unset = ['AGENTIFY_URL', 'BUYER_PRIVATE_KEY', 'ITEM_ID'].filter(
    (name) => !process.env[name],
  )
  if (unset.length > 0) {
    console.error(`.env does not set ${unset.join(', ')}.`)
    return 1
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(process.env.BUYER_PRIVATE_KEY ?? '')) {
    console.error('BUYER_PRIVATE_KEY in .env is not a private key: 0x and 64 hex digits.')
    return 1
  }
  const buyer = privateKeyToAccount(process.env.BUYER_PRIVATE_KEY as `0x${string}`)

  let kept: Kept
  if (existsSync(KEPT)) {
    kept = JSON.parse(readFileSync(KEPT, 'utf8')) as Kept
    console.log(`Taking up the purchase kept in ${KEPT}.`)
  } else {
    const asked = await askToBuy(buyer)
    if (typeof asked === 'string') {
      console.error(asked)
      return 1
    }
    kept = asked
  }

  let order: Order | undefined
  let paidThisRun = false
  if (kept.status_url === undefined) {
    const paid = await pay(kept, buyer)
    if (typeof paid === 'string') {
      console.error(paid)
      return 1
    }
    order = paid
    paidThisRun = true
  }

  // Goods that come later are collected at the order's own address. A read
  // that fails says nothing about the order, so it is reported and read again.
  for (let reads = 0; ; reads += 1) {
    if (order !== undefined && !STILL_MOVING.includes(order.status)) {
      if (order.status !== 'delivered_unpaid') return ended(order)
      // The goods are made and held, and a payment for this same purchase
      // releases them; one run pays once, so a failing wallet is not tried in a loop.
      if (paidThisRun) {
        console.error(
          `Order ${order.order_id}: the goods are made and the charge for them did not ` +
            'go through. Make sure the wallet holds the price, then run this again: it ' +
            'pays the kept payment request again, which releases the goods.',
        )
        return 1
      }
      const paid = await pay(kept, buyer)
      if (typeof paid === 'string') {
        console.error(paid)
        return 1
      }
      order = paid
      paidThisRun = true
      continue
    }
    if (reads === READS) {
      const last = order === undefined ? 'no read answered' : `it reads ${order.status}`
      console.error(
        `The order has not finished after ${READS} reads (${last}). ` +
          `Run this again to go on reading it at the address kept in ${KEPT}.`,
      )
      return 1
    }
    if (reads > 0 || order !== undefined) await sleep(WAIT_MS)
    const read = await call(kept.status_url as string, "The order's address")
    const latest = orderIn(read)
    if (latest === undefined) console.error(`The order could not be read. ${said(read)}`)
    else order = latest
  }
}

process.exitCode = await buy().catch((error: Error) => {
  console.error(`The purchase stopped: ${error.message}`)
  return 1
})
