/** Spike only: the smallest use of CDP's embedded wallet, without its interface, that hands back an address. */
import { initialize, signInWithEmail, verifyEmailOTP } from "@coinbase/cdp-core";

export async function connect(): Promise<string> {
  const email = "merchant@example.com";
  const code = async (): Promise<string> => "000000";
  await initialize({ projectId: "spike", ethereum: { createOnLogin: "eoa" } });
  const { flowId } = await signInWithEmail({ email });
  const { user } = await verifyEmailOTP({ flowId, otp: await code() });
  return user.evmAccounts?.[0] ?? "";
}
