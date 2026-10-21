import {
  type Address,
  createPublicClient,
  type EIP1193RequestFn,
  type Hex,
  http,
  RpcRequestError,
  type Transport,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import type { SignatureReader } from "../../ports/signatures.js";

/**
 * Signatures judged on `network` through `rpcUrl`, the endpoint payment
 * recovery reads, or none where no endpoint is configured. An endpoint that
 * serves another chain, or does not answer, gives no verdict: judged there,
 * a contract wallet would read as one that does not exist.
 */
export function signaturesOn(network: string, rpcUrl?: string): SignatureReader | undefined {
  if (!rpcUrl) return undefined;
  const chain = network === "eip155:8453" ? base : baseSepolia;
  const host = new URL(rpcUrl).host;
  return {
    async accepts(wallet, digest, signature) {
      // viem reads a call that did not reach the chain as a refused
      // signature, so whether every call was answered is watched here.
      let unanswered = false;
      const watched: Transport = (options) => {
        const made = http(rpcUrl, { timeout: 10_000, retryCount: 0 })(options);
        const request = (async (args: Parameters<EIP1193RequestFn>[0]) => {
          try {
            return await made.request(args);
          } catch (thrown) {
            // An error the endpoint answered with, a revert among them, is the
            // chain's answer; anything else means it was not asked.
            if (!(thrown instanceof RpcRequestError)) unanswered = true;
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
      const valid = await client
        .verifyHash({
          address: wallet as Address,
          hash: digest as Hex,
          signature: signature as Hex,
        })
        .catch(() => {
          unanswered = true;
          return false;
        });
      if (!valid && unanswered) throw new Error(`the chain endpoint at ${host} did not answer`);
      return valid;
    },
  };
}
