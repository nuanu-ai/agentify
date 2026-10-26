import { x402Client } from '@x402/core/client'
import { registerExactEvmScheme } from '@x402/evm/exact/client'
import { wrapFetchWithPayment } from '@x402/fetch'
import { privateKeyToAccount } from 'viem/accounts'

// The buyer's wallet, holding test USDC and nothing else.
const buyer = privateKeyToAccount(process.env.BUYER_PRIVATE_KEY as `0x${string}`)
const client = new x402Client()
registerExactEvmScheme(client, { signer: buyer })
client.setSpendControls({ maxAmountPerPayment: '$10' })
const payingFetch = wrapFetchWithPayment(fetch, client)

// What this program reads of the catalogue and of an order.
type Catalogue = { items: { id: string; purchase_url: string }[] }
type Order = { status: string; status_url: string; delivered: unknown }

// Your card in the test channel's catalogue, by the id step 3 returned.
const listed = await fetch('https://test.agentify.ad/x402/catalog')
const catalogue = (await listed.json()) as Catalogue
const card = catalogue.items.find((item) => item.id === process.env.ITEM_ID)
if (card === undefined) throw new Error('the card is not in the test catalogue')

const bought = await payingFetch(card.purchase_url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ params: { email: 'you@example.com' } }),
})
// A refusal carries no order: print it rather than read it as one.
const answer = (await bought.json()) as Partial<Order>
if (typeof answer.status_url !== 'string') {
  throw new Error(`${bought.status}: ${JSON.stringify(answer)}`)
}
let order = answer as Order

// Goods that come later are collected at the order's own address.
for (let tries = 0; order.status === 'in_progress' && tries < 60; tries += 1) {
  await new Promise((resolve) => setTimeout(resolve, 5_000))
  order = (await (await fetch(order.status_url)).json()) as Order
}

console.log(order.status, order.delivered)
