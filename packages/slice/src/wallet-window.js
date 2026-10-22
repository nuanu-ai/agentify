/*
 * The stand-in for Coinbase Wallet's window, served by `pnpm wallet-faults` in
 * place of https://keys.coinbase.com/connect inside the browser it opens. The
 * dashboard's own Coinbase code, @base-org/account, runs unchanged in the
 * dashboard's page and talks to this window exactly as it talks to Coinbase's:
 * the window says it has loaded, takes the page's introduction, answers each
 * handshake with a key of its own, and reads and answers each request
 * encrypted under the key that handshake agreed. What it answers is chosen by
 * whoever sits at the window, one request at a time.
 *
 * Nothing here holds a wallet. It never signs: the one key it makes is the
 * session key of the encryption between the page and the window, made afresh
 * for every handshake, and the address it gives is the one the organiser
 * named on the command line. An acknowledged payout is a made-up batch
 * identifier that names nothing on any chain.
 *
 * Every event is written to the console as one line of JSON starting with
 * "stand-in", which the command prints in its terminal.
 */

(() => {
  const ADDRESS = document.body.dataset.address ?? "";
  const pageOrigin = new URL(location.href).searchParams.get("origin");
  const page = window.opener;

  const say = (event) => console.info(`stand-in ${JSON.stringify(event)}`);

  if (page === null || pageOrigin === null) {
    say({ kind: "orphan" });
    document.getElementById("requests").textContent =
      "This window was not opened by the dashboard's Coinbase button, so there is nothing to answer.";
    return;
  }

  const hex = (bytes) =>
    [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const unhex = (text) => new Uint8Array(text.match(/.{1,2}/g).map((b) => Number.parseInt(b, 16)));
  const post = (message) => page.postMessage(message, pageOrigin);
  const ECDH = { name: "ECDH", namedCurve: "P-256" };

  /** The identifier of this window's "loaded" message, which the page's introduction answers. */
  const loaded = crypto.randomUUID();
  /** One session per handshake, found by the page's public key, which every request carries. */
  const sessions = new Map();
  let sessionsMade = 0;
  let requestsSeen = 0;
  /** Set by "Vanish without a word", so the window goes without telling the page. */
  let vanishing = false;

  const sealed = async (key, payload) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipherText = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(JSON.stringify(payload)),
    );
    return { iv, cipherText };
  };

  const answer = (request, content) => {
    post({
      id: crypto.randomUUID(),
      requestId: request.message.id,
      sender: request.session.publicHex,
      content,
      timestamp: new Date(),
    });
  };

  const shortened = (address) => `${address.slice(0, 6)}…${address.slice(-4)}`;

  /** What the wallet answers when it does what it was asked. */
  const valueFor = (method) => {
    if (method === "wallet_connect") return { accounts: [{ address: ADDRESS, capabilities: {} }] };
    if (method === "wallet_sendCalls")
      return { id: `0x${hex(crypto.getRandomValues(new Uint8Array(32)))}` };
    return null;
  };

  /** A value of the wrong shape for its method, decrypted without trouble by the page. */
  const wrongShapeFor = (method) => {
    if (method === "wallet_connect")
      return { accounts: [{ address: shortened(ADDRESS), capabilities: {} }] };
    if (method === "wallet_sendCalls") return {};
    return "not what this method returns";
  };

  const ANSWERS = {
    wallet: {
      label: "Answer as the wallet",
      said: (request) =>
        request.method === "wallet_connect"
          ? `gave the address ${ADDRESS}`
          : request.method === "wallet_sendCalls"
            ? "acknowledged the batch with a made-up identifier; nothing was sent on any chain"
            : "answered as the wallet",
      send: async (request) =>
        answer(request, {
          encrypted: await sealed(request.session.key, {
            result: { value: valueFor(request.method) },
          }),
        }),
    },
    refuse: {
      label: "Refuse (4001)",
      said: () => "refused with EIP-1193 code 4001, as a person declining does",
      send: async (request) =>
        answer(request, {
          encrypted: await sealed(request.session.key, {
            result: { error: { code: 4001, message: "User rejected the request." } },
          }),
        }),
    },
    unreadable: {
      label: "Unreadable answer",
      said: () => "answered under a key the page does not hold, so it cannot be decrypted",
      send: async (request) => {
        const stranger = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
          "encrypt",
        ]);
        answer(request, {
          encrypted: await sealed(stranger, { result: { value: valueFor(request.method) } }),
        });
      },
    },
    outside: {
      label: "Answer outside the protocol",
      said: () => "answered with a message that carries no content at all",
      send: async (request) => answer(request, undefined),
    },
    afterClose: {
      label: "Say the window closed, then answer as the wallet",
      said: (request) =>
        `told the page this window closed, then at once ${ANSWERS.wallet.said(request)}`,
      send: async (request) => {
        const sealedAnswer = await sealed(request.session.key, {
          result: { value: valueFor(request.method) },
        });
        // Both in one turn, so the answer is on its way before the page,
        // hearing of the close, shuts this window.
        post({ event: "PopupUnload", id: crypto.randomUUID() });
        answer(request, { encrypted: sealedAnswer });
      },
    },
    shape: {
      label: "Answer in the wrong shape",
      said: (request) =>
        request.method === "wallet_connect"
          ? `gave the address shortened as a wallet displays it, ${shortened(ADDRESS)}`
          : request.method === "wallet_sendCalls"
            ? "acknowledged with an object that names no batch"
            : "answered with a value of the wrong shape",
      send: async (request) =>
        answer(request, {
          encrypted: await sealed(request.session.key, {
            result: { value: wrongShapeFor(request.method) },
          }),
        }),
    },
  };

  const list = document.getElementById("requests");
  list.textContent = "";

  const describe = (method, params) => {
    if (method !== "wallet_sendCalls") return "";
    const [batch] = Array.isArray(params) ? params : [];
    const [call] = Array.isArray(batch?.calls) ? batch.calls : [];
    return `from ${batch?.from} on chain ${batch?.chainId}: a call to ${call?.to}, value ${call?.value}, ${
      typeof call?.data === "string" ? (call.data.length - 2) / 2 : "no"
    } bytes of data`;
  };

  const show = (request) => {
    const card = document.createElement("section");
    card.className = "request";
    const title = document.createElement("h2");
    title.textContent = `#${request.number} ${request.method}`;
    const detail = document.createElement("p");
    detail.textContent = `Session ${request.session.number}. ${describe(request.method, request.params)}`;
    const state = document.createElement("p");
    state.className = "state";
    state.setAttribute("role", "status");
    const buttons = document.createElement("div");
    buttons.className = "buttons";
    card.append(title, detail, state, buttons);
    list.prepend(card);

    const settle = (choice, late) => async () => {
      buttons.textContent = "";
      const said = ANSWERS[choice].said(request);
      state.textContent = late ? `Held, then ${said}.` : `This window ${said}.`;
      await ANSWERS[choice].send(request);
      say({ kind: "answered", number: request.number, method: request.method, choice, late, said });
    };
    const offer = (choices, late) => {
      buttons.textContent = "";
      for (const choice of choices) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = late ? `${ANSWERS[choice].label} now` : ANSWERS[choice].label;
        button.addEventListener("click", settle(choice, late));
        buttons.append(button);
      }
    };
    offer(["wallet", "refuse", "unreadable", "outside", "shape", "afterClose"], false);
    const hold = document.createElement("button");
    hold.type = "button";
    hold.textContent = "Hold the answer";
    hold.addEventListener("click", () => {
      state.textContent =
        "Held: the page has been told nothing. Send an answer whenever you choose.";
      offer(["wallet", "refuse", "afterClose"], true);
      say({ kind: "held", number: request.number, method: request.method });
    });
    buttons.append(hold);
    state.textContent = "Waiting for your choice. The page has been told nothing.";
  };

  const handshake = async (message) => {
    const keys = await crypto.subtle.generateKey(ECDH, true, ["deriveKey"]);
    const peer = await crypto.subtle.importKey("spki", unhex(message.sender), ECDH, true, []);
    const key = await crypto.subtle.deriveKey(
      { name: "ECDH", public: peer },
      keys.privateKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    sessionsMade += 1;
    const session = {
      number: sessionsMade,
      key,
      publicHex: hex(await crypto.subtle.exportKey("spki", keys.publicKey)),
    };
    sessions.set(message.sender, session);
    answer({ message, session }, { encrypted: await sealed(key, { result: { value: null } }) });
    say({ kind: "handshake", session: session.number });
  };

  const request = async (message) => {
    const session = sessions.get(message.sender);
    requestsSeen += 1;
    if (session === undefined) {
      say({ kind: "unknown-session", number: requestsSeen });
      return;
    }
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: message.content.encrypted.iv },
      session.key,
      message.content.encrypted.cipherText,
    );
    const { action } = JSON.parse(new TextDecoder().decode(plain));
    const asked = {
      number: requestsSeen,
      message,
      session,
      method: action?.method,
      params: action?.params,
    };
    // Moving the wallet to the chain the payout names is answered at once, as
    // it changes nothing a person approves.
    if (asked.method === "wallet_switchEthereumChain") {
      await ANSWERS.wallet.send(asked);
      say({
        kind: "routine",
        number: asked.number,
        method: asked.method,
        chain: asked.params?.[0]?.chainId,
      });
      return;
    }
    say({
      kind: "asked",
      number: asked.number,
      method: asked.method,
      session: session.number,
      detail: describe(asked.method, asked.params),
    });
    show(asked);
  };

  window.addEventListener("message", (event) => {
    if (event.origin !== pageOrigin || event.source !== page) return;
    const message = event.data;
    if (message?.requestId === loaded) {
      say({ kind: "introduced", sdk: `${message.data?.sdkName} ${message.data?.version}` });
      return;
    }
    const handled = message?.content?.handshake
      ? handshake(message)
      : message?.content?.encrypted
        ? request(message)
        : Promise.resolve(say({ kind: "unrecognised" }));
    handled.catch((thrown) => say({ kind: "failed", why: String(thrown) }));
  });

  // A window a person closes tells the page so, as Coinbase's does.
  window.addEventListener("pagehide", () => {
    if (!vanishing) post({ event: "PopupUnload", id: crypto.randomUUID() });
  });

  document.getElementById("close").addEventListener("click", () => {
    say({ kind: "closing" });
    window.close();
  });
  document.getElementById("vanish").addEventListener("click", () => {
    vanishing = true;
    say({ kind: "vanishing" });
    window.close();
  });

  post({ event: "PopupLoaded", id: loaded });
  say({ kind: "loaded", origin: pageOrigin });
})();
