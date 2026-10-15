/** Spike only: CDP's embedded wallet with Coinbase's ready-made sign-in, rendered where the probe button was. */
import { AuthButton, CDPReactProvider } from "@coinbase/cdp-react";
import { createRoot } from "react-dom/client";

export async function connect(): Promise<string> {
  const place = document.createElement("div");
  document.body.append(place);
  createRoot(place).render(
    <CDPReactProvider config={{ projectId: "spike", ethereum: { createOnLogin: "eoa" }, appName: "Agentify" }}>
      <AuthButton />
    </CDPReactProvider>,
  );
  return "";
}
