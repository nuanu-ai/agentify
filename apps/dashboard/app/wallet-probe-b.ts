/** Spike only: the smallest use of the Base Account SDK that hands back an address. */
import { createBaseAccountSDK } from "@base-org/account";

export async function connect(): Promise<string> {
  const provider = createBaseAccountSDK({ appName: "Agentify", appChainIds: [84532] }).getProvider();
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  return accounts[0] ?? "";
}
