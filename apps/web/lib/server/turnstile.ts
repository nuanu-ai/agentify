type TurnstileVerification = {
  success?: boolean;
  action?: string;
  hostname?: string;
};

export async function verifyTurnstileToken(input: {
  token: string;
  remoteIp: string;
  secret: string;
  expectedHostname: string;
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
      result.action === "scan" &&
      result.hostname === input.expectedHostname
    );
  } catch {
    return false;
  }
}
