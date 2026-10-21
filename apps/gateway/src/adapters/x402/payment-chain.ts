import {
  type Address,
  createPublicClient,
  type EIP1193RequestFn,
  type Hex,
  http,
  parseAbi,
  RpcRequestError,
  type Transport,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import type { PaymentChain } from "../../ports/payment-chain.js";

const EIP3009 = parseAbi([
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
]);

/**
 * The chain `network` read through `rpcUrl`, the endpoint payment recovery
 * reads, or none where no endpoint is configured. An endpoint that serves
 * another chain, or does not answer, gives no verdict: read there, a contract
 * wallet would look like one that does not exist and every authorization
 * like one never used.
 */
export function paymentChainOn(network: string, rpcUrl?: string): PaymentChain | undefined {
  if (!rpcUrl) return undefined;
  const chain = network === "eip155:8453" ? base : baseSepolia;
  const host = new URL(rpcUrl).host;

  /** A client for one question, and whether every call it made was answered by the chain. */
  const asking = async () => {
    const heard = { unanswered: false };
    const watched: Transport = (options) => {
      const made = http(rpcUrl, { timeout: 10_000, retryCount: 0 })(options);
      const request = (async (args: Parameters<EIP1193RequestFn>[0]) => {
        try {
          return await made.request(args);
        } catch (thrown) {
          if (!revertedOnChain(thrown)) heard.unanswered = true;
          throw thrown;
        }
      }) as EIP1193RequestFn;
      return { ...made, request };
    };
    const client = createPublicClient({ chain, transport: watched });
    const serves = await client.getChainId().catch(() => null);
    if (serves !== chain.id) {
      throw new Error(`the chain endpoint at ${host} does not answer for ${network}`);
    }
    return { client, heard };
  };

  return {
    async accepts(wallet, digest, signature) {
      const { client, heard } = await asking();
      // viem reads a call that did not reach the chain as a refused
      // signature, so whether every call was answered is watched instead.
      const valid = await client
        .verifyHash({
          address: wallet as Address,
          hash: digest as Hex,
          signature: signature as Hex,
        })
        .catch(() => {
          heard.unanswered = true;
          return false;
        });
      if (!valid && heard.unanswered) {
        throw new Error(`the chain endpoint at ${host} did not answer`);
      }
      return valid;
    },
    async used(token, wallet, nonce) {
      const { client } = await asking();
      return client.readContract({
        address: token as Address,
        abi: EIP3009,
        functionName: "authorizationState",
        args: [wallet as Address, nonce as Hex],
      });
    },
  };
}

/**
 * Whether an endpoint's error is the chain's own verdict: a call that ran and
 * reverted. Every other error, a rate limit written as a JSON-RPC error among
 * them, means the chain was not asked.
 */
function revertedOnChain(thrown: unknown): boolean {
  return (
    thrown instanceof RpcRequestError &&
    (thrown.code === 3 || /revert/i.test(String(thrown.details ?? thrown.shortMessage)))
  );
}
