import { appendFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { x402Client, x402HTTPClient } from '@x402/core/client'
import { registerExactEvmScheme } from '@x402/evm/exact/client'
import { privateKeyToAccount } from 'viem/accounts'

type Card = { id: string; purchase_url: string; price: { amount: string } }
type Order = { order_id: string; status: string; status_url: string }

// The order's address carries the buyer's key, the only thing that opens the
// order, so it is written here, readable by you alone, and never printed.
const ADDRESSES = 'orders.txt'

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
    `Order ${order.order_id} ${what}. Its address is in ${ADDRESSES}, and the order is ` +
      "on your dashboard's Orders screen.",
  )

async function buy(): Promise<void> {
  const { AGENTIFY_URL, BUYER_PRIVATE_KEY, ITEM_ID } = process.env
  if (!AGENTIFY_URL || !BUYER_PRIVATE_KEY || !ITEM_ID) {
    throw new Error('.env needs AGENTIFY_URL, BUYER_PRIVATE_KEY and ITEM_ID.')
  }
  const catalogue = (await (await fetch(`${AGENTIFY_URL}/x402/catalog`)).json()) as {
    items: Card[]
  }
  const card = catalogue.items.find((item) => item.id === ITEM_ID)
  if (card === undefined) throw new Error(`${ITEM_ID} is not in the catalogue.`)

  // Asking to buy is answered 402, with a payment request. Nothing is charged yet.
  const purchase = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ params: { email: 'you@example.com' } }),
  }
  const asked = await fetch(card.purchase_url, purchase)
  if (asked.status !== 402) throw new Error(`HTTP ${asked.status}: ${await asked.text()}`)

  // The wallet signs only on Base Sepolia, the test channel's chain, and for no
  // more than the card's price; any other payment request is refused unsigned.
  const client = new x402Client()
  const signer = privateKeyToAccount(BUYER_PRIVATE_KEY as `0x${string}`)
  registerExactEvmScheme(client, { signer, networks: ['eip155:84532'] })
  client.setSpendControls({ maxAmountPerPayment: `$${card.price.amount}` })
  const payer = new x402HTTPClient(client)
  const payment = await payer.createPaymentPayload(
    payer.getPaymentRequiredResponse((name) => asked.headers.get(name)),
  )

  // The same purchase again, carrying the payment. It is sent once.
  const headers = { ...purchase.headers, ...payer.encodePaymentSignatureHeader(payment) }
  let order = await orderIn(fetch(card.purchase_url, { ...purchase, headers }))
  if (order === undefined)
    throw new Error("No order came back; your dashboard's Orders shows if one was made.")
  appendFileSync(ADDRESSES, `${order.order_id} ${order.status_url}\n`, { mode: 0o600 })
  console.log(`Order ${order.order_id}: ${order.status}`)

  // Goods that come later are read at the order's address, every five seconds for five minutes.
  for (let reads = 0; order.status === 'in_progress' && reads < 60; reads += 1) {
    await sleep(5_000)
    const latest: Order | undefined = await orderIn(fetch(order.status_url))
    if (latest === undefined) throw stopped(order, 'could not be read')
    order = latest
  }
  // Everything the order says, the goods included, except its address.
  console.log(JSON.stringify({ ...order, status_url: undefined }, null, 2))
  if (order.status === 'in_progress') throw stopped(order, 'has not finished in five minutes')
  if (order.status !== 'delivered') throw stopped(order, `reads ${order.status}`)
}

await buy().catch((error: Error) => {
  console.error(`The purchase stopped. ${error.message}`)
  process.exitCode = 1
})
