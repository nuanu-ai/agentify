/**
 * The wallet fault browser's two promises that hold without a browser: it is
 * refused at the door, in a sentence naming the flag, when it is not told
 * which dashboard to open or which address its stand-in gives; and of every
 * address a page in it asks for, only the dashboard's origin is reached and
 * only Coinbase's window address is answered by the stand-in.
 */

import { describe, expect, it } from "vitest";
import { destinationOf, readPlan } from "./wallet-faults-command.js";

const ADDRESS = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";
const DASHBOARD = "http://127.0.0.1:18642/dashboard";

const refusal = (argv: readonly string[]): string => {
  const read = readPlan(argv);
  if (read.ok) throw new Error("the plan was accepted");
  return read.why;
};

describe("the command's door", () => {
  it("opens the named dashboard with the named address, spelled with its checksum", () => {
    const read = readPlan(["--dashboard", DASHBOARD, "--address", ADDRESS.toLowerCase()]);
    expect(read.ok && read.plan.dashboard.href).toBe(DASHBOARD);
    expect(read.ok && read.plan.address).toBe(ADDRESS);
  });

  it("refuses to start without a dashboard, naming the flag", () => {
    expect(refusal(["--address", ADDRESS])).toMatch(/^--dashboard is required/);
  });

  it("refuses to start without the address the stand-in gives, naming the flag", () => {
    expect(refusal(["--dashboard", DASHBOARD])).toMatch(/^--address is required/);
  });

  it("refuses a flag it does not know, without repeating what follows its equals sign", () => {
    const why = refusal(["--dashboard=http://user:secret@host", "--address", ADDRESS]);
    expect(why).toMatch(/--dashboard or --address/);
    expect(why).not.toContain("secret");
  });

  it("refuses a dashboard address that is not http, carries a query, or carries a password", () => {
    for (const dashboard of [
      "ftp://127.0.0.1/dashboard",
      `${DASHBOARD}?next=settings`,
      "http://user:pass@127.0.0.1/dashboard",
      "not an address",
    ]) {
      expect(refusal(["--dashboard", dashboard, "--address", ADDRESS])).toMatch(/^--dashboard/);
    }
  });

  it("refuses to treat any host of Coinbase's as the dashboard, since that host would become reachable", () => {
    for (const dashboard of [
      "https://keys.coinbase.com/connect",
      "http://keys.coinbase.com/connect",
      "https://wallet.coinbase.com/",
      "https://coinbase.com/",
    ]) {
      expect(refusal(["--dashboard", dashboard, "--address", ADDRESS])).toMatch(
        /a host of Coinbase's/,
      );
    }
  });

  it("refuses an address that is not an EVM address or whose checksum is wrong", () => {
    for (const address of ["0x8ba1…BA72", ADDRESS.slice(0, 41), ADDRESS.replace("B", "b")]) {
      expect(refusal(["--dashboard", DASHBOARD, "--address", address])).toMatch(/^--address/);
    }
  });
});

describe("where a request from the browser goes", () => {
  const dashboard = new URL(DASHBOARD);

  it("reaches the dashboard's origin, every path on it", () => {
    expect(destinationOf(`${DASHBOARD}/settings`, dashboard)).toBe("dashboard");
    expect(destinationOf("http://127.0.0.1:18642/assets/a.js", dashboard)).toBe("dashboard");
  });

  it("answers Coinbase's window address with the stand-in, whatever its query", () => {
    expect(
      destinationOf("https://keys.coinbase.com/connect?sdkName=%40base-org%2Faccount", dashboard),
    ).toBe("stand-in");
  });

  it("refuses every other address, Coinbase's other ones and the dashboard's host on another port or scheme included", () => {
    for (const url of [
      "https://keys.coinbase.com/",
      "https://keys.coinbase.com/connect/elsewhere",
      "http://keys.coinbase.com/connect",
      "https://rpc.wallet.coinbase.com/",
      "https://wallet.coinbase.com/",
      "https://docs.cloud.coinbase.com/wallet-sdk/docs/errors",
      "http://127.0.0.1:18643/dashboard/settings",
      "https://127.0.0.1:18642/dashboard/settings",
      "data:text/plain,hello",
    ]) {
      expect(destinationOf(url, dashboard)).toBe("refused");
    }
  });
});
