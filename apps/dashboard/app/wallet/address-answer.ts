import { LIMIT, NOT_OPENED, UNCOUNTED } from "./button-state.js";
import { askAddress, coinbaseWallet } from "./coinbase.js";
import { pressesOf } from "./presses.js";

export const ADDRESS_ANSWERS = {
  addressInTheBox: "The address is in the box. Check it against your wallet, then save it.",
  connectClosed: "Coinbase Wallet was closed. The box is as you left it.",
  connectLost:
    "Coinbase Wallet's answer was lost, as happens when another of its buttons is pressed while its window is open. Press again.",
  connectUnanswered: `Coinbase Wallet didn't answer within ${LIMIT}, so this page stopped waiting. The box is as you left it. Press again.`,
  connectFailed: "Coinbase Wallet gave no address. You can still paste one.",
} as const;

function addressAnswer(
  asked: Awaited<ReturnType<typeof askAddress>> | typeof NOT_OPENED,
  box: string,
  alone: () => boolean,
  notOpened: string,
): string {
  if (asked.kind === "address") {
    const field = document.getElementById(box);
    if (field instanceof HTMLInputElement) {
      field.value = asked.address;
      // What follows the box, the address shown in groups under it, hears
      // of the new value as it hears of typing.
      field.dispatchEvent(new Event("input", { bubbles: true }));
      // A refusal of the address typed before would be read out against
      // this one, so it comes off the box until the next save is answered.
      if (field.getAttribute("aria-invalid") === "true") {
        const line = field.getAttribute("aria-describedby");
        if (line !== null) document.getElementById(line)?.setAttribute("hidden", "");
        field.removeAttribute("aria-invalid");
        field.removeAttribute("aria-describedby");
      }
      field.focus();
    }
  }
  // An answer another press overtook can fail as lost or with an error of
  // the browser's cryptography; either way it was lost.
  return asked.kind === "address"
    ? ADDRESS_ANSWERS.addressInTheBox
    : asked.kind === "unanswered"
      ? ADDRESS_ANSWERS.connectUnanswered
      : asked.kind === "cancelled"
        ? ADDRESS_ANSWERS.connectClosed
        : asked.kind === "lost" || !alone()
          ? ADDRESS_ANSWERS.connectLost
          : asked.kind === "notOpened"
            ? notOpened
            : ADDRESS_ANSWERS.connectFailed;
}

/** All provider operations begin after the press, with both buttons sharing its session. */
export async function chooseAddress(
  chainId: number,
  box: string,
  pressed: Readonly<{
    latest: () => boolean;
    say: (message: string) => void;
  }>,
  notOpened: string,
) {
  let alone = UNCOUNTED;
  let asked: Awaited<ReturnType<typeof askAddress>> | typeof NOT_OPENED;
  try {
    const wallet = coinbaseWallet(chainId);
    alone = pressesOf(wallet).begin();
    asked = await askAddress(wallet, alone);
  } catch {
    asked = NOT_OPENED;
  }
  if (!pressed.latest()) return;
  pressed.say(addressAnswer(asked, box, alone, notOpened));
}
