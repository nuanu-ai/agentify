import { setTimeout as sleep } from 'node:timers/promises'
import { registerExactEvmScheme } from '@x402/evm/exact/client'
import { wrapFetchWithPayment, x402Client } from '@x402/fetch'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

type Card = { id: string; purchase_url: string; price: { amount: string } }
type Order = { status?: string; status_url: string }

const { AGENTIFY_URL, ITEM_ID, BUYER_PRIVATE_KEY } = process.env
if (!AGENTIFY_URL || !ITEM_ID) throw new Error('.env needs AGENTIFY_URL and ITEM_ID.')

if (!BUYER_PRIVATE_KEY) {
  const key = generatePrivateKey()
  console.log(`Add this line to .env:\n\nBUYER_PRIVATE_KEY=${key}\n`)
  console.log(`Then get test USDC on Base Sepolia for ${privateKeyToAccount(key).address}`)
  console.log('at https://faucet.circle.com and run this program again.')
} else {
  const catalog = await fetch(new URL('/x402/catalog', AGENTIFY_URL))
  const { items } = (await catalog.json()) as { items: Card[] }
  const card = items.find((item) => item.id === ITEM_ID)
  if (!card)
    throw new Error(`${ITEM_ID} is not in the catalogue. Is the process from step 3 running?`)

  const client = new x402Client()
  const signer = privateKeyToAccount(BUYER_PRIVATE_KEY as `0x${string}`)
  registerExactEvmScheme(client, { signer, networks: ['eip155:84532'] })
  // The x402 client refuses to pay more than 1 USD unless it is given a limit.
  client.setSpendControls({ maxAmountPerPayment: `$${card.price.amount}` })

  const answer = await wrapFetchWithPayment(fetch, client)(card.purchase_url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ params: { email: 'you@example.com' } }),
  })
  let order = (await answer.json()) as Order
  for (let reads = 0; order.status === 'in_progress' && reads < 12; reads += 1) {
    await sleep(5_000)
    order = (await (await fetch(order.status_url)).json()) as Order
  }
  console.log(JSON.stringify(order, null, 2))
}
