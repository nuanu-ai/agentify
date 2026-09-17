type TurnstileVerification = {
  success?: boolean;
  action?: string;
  hostname?: string;
};

export type TurnstileAction = "scan" | "report_recovery";

export async function verifyTurnstileToken(input: {
  token: string;
  remoteIp: string;
  secret: string;
  expectedHostname: string;
  action: TurnstileAction;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        body: new URLSearchParams({
          secret: input.secret,
          response: input.token,
          remoteip: input.remoteIp,
        }),
      },
    );
    if (!response.ok) return false;
    const result = (await response.json()) as TurnstileVerification;
    return (
      result.success === true &&
      result.action === input.action &&
      result.hostname === input.expectedHostname
    );
  } catch {
    return false;
  }
}
