/**
 * The provider is a real HTTP server on a loopback port rather than a stubbed
 * `fetch`, because what matters is the document that goes over the wire.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isSandboxMail, type Message, postmanFor, SANDBOX_MAIL } from "./mail.js";

const MESSAGE: Message = {
  to: "owner@example.com",
  subject: "Sign in to your Agentify dashboard",
  body: "Open this:\n\n    https://agentify.example/sign-in/open?token=abc\n",
  html: '<a href="https://agentify.example/sign-in/open?token=abc">Open your dashboard</a>',
};

const logged = async (during: () => Promise<void>): Promise<string> => {
  const lines: string[] = [];
  const collect = (...parts: unknown[]) => lines.push(parts.map(String).join(" "));
  const log = vi.spyOn(console, "log").mockImplementation(collect);
  const error = vi.spyOn(console, "error").mockImplementation(collect);
  try {
    await during();
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
  return lines.join("\n");
};

interface Provider {
  readonly url: string;
  readonly asked: { path: string; authorization: string; body: string }[];
  close(): Promise<void>;
}

let running: Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (running === null) {
      resolve();
      return;
    }
    running.close(() => resolve());
  });
  running = null;
});

const provider = async (status = 200, answerAfterMs = 0): Promise<Provider> => {
  const asked: { path: string; authorization: string; body: string }[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      asked.push({
        path: request.url ?? "",
        authorization: request.headers.authorization ?? "",
        body,
      });
      const answer = () => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(status === 200 ? { id: "msg_1" } : { message: "no" }));
      };
      if (answerAfterMs === 0) answer();
      else setTimeout(answer, answerAfterMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  running = server;
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    asked,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

describe("a dashboard with no mail provider", () => {
  it("writes the whole message down, with the address it was for and the link in it", async () => {
    // On a laptop the developer reads the link out of their own terminal, so
    // the log line must say where and what.
    const postman = postmanFor({ mailUrl: SANDBOX_MAIL, mailApiKey: null, mailFrom: "x" });

    const said = await logged(async () => {
      // Taken: on a laptop the log is the only sink there is.
      await expect(postman(MESSAGE)).resolves.toBe("accepted");
    });

    expect(said).toContain("owner@example.com");
    expect(said).toContain("https://agentify.example/sign-in/open?token=abc");
    expect(said).toMatch(/not sent|no mail provider/i);
  });

  it("names an attached file and its size without writing what the file holds", async () => {
    // An attachment is a person's copy of their own data; the log is read by
    // whoever runs the host.
    const postman = postmanFor({ mailUrl: SANDBOX_MAIL, mailApiKey: null, mailFrom: "x" });

    const said = await logged(async () => {
      await postman({
        ...MESSAGE,
        attachments: [
          { filename: "copy.json", contentType: "application/json", content: '{"phone":"+62"}' },
        ],
      });
    });

    expect(said).toContain("copy.json");
    expect(said).toContain("15 bytes");
    expect(said).not.toContain("+62");
  });

  it("is what the dashboard is in without a provider, and is told apart by name", () => {
    expect(isSandboxMail(SANDBOX_MAIL)).toBe(true);
    expect(isSandboxMail("https://api.resend.com")).toBe(false);
  });
});

describe("a dashboard with a mail provider", () => {
  it("sends one message, with the sender, recipient, plaintext and HTML on it", async () => {
    const sending = await provider();
    const postman = postmanFor({
      mailUrl: sending.url,
      mailApiKey: "re_a_real_looking_key",
      mailFrom: "Agentify <no-reply@mail.example.com>",
    });

    await postman(MESSAGE);

    expect(sending.asked).toHaveLength(1);
    const asked = sending.asked[0];
    expect(asked?.path).toBe("/emails");
    expect(asked?.authorization).toBe("Bearer re_a_real_looking_key");
    const document = JSON.parse(asked?.body ?? "{}") as {
      from: string;
      to: string[];
      subject: string;
      text: string;
      html: string;
    };
    expect(document.from).toBe("Agentify <no-reply@mail.example.com>");
    expect(document.to).toStrictEqual(["owner@example.com"]);
    expect(document.subject).toBe(MESSAGE.subject);
    expect(document.text).toBe(MESSAGE.body);
    expect(document.html).toBe(MESSAGE.html);
  });

  it("sends an attached file as the provider takes one: its name and its bytes in base64", async () => {
    const sending = await provider();
    const postman = postmanFor({
      mailUrl: sending.url,
      mailApiKey: "re_a_real_looking_key",
      mailFrom: "Agentify <no-reply@mail.example.com>",
    });
    const content = '{"about":"owner@example.com","name":"Café"}';

    await postman({
      ...MESSAGE,
      attachments: [{ filename: "copy.json", contentType: "application/json", content }],
    });

    const document = JSON.parse(sending.asked[0]?.body ?? "{}") as {
      attachments?: { filename: string; content: string; content_type?: string }[];
    };
    expect(document.attachments).toEqual([
      {
        filename: "copy.json",
        content: Buffer.from(content, "utf8").toString("base64"),
        content_type: "application/json",
      },
    ]);
  });

  it("records provider acceptance without the recipient or action URL", async () => {
    // Written down as well as answered, so a reader of the log can tell a
    // message that went to the provider from one never asked for.
    const sending = await provider();
    const postman = postmanFor({
      mailUrl: sending.url,
      mailApiKey: "re_a_real_looking_key",
      mailFrom: "Agentify <no-reply@mail.example.com>",
    });

    const said = await logged(async () => {
      await expect(postman(MESSAGE)).resolves.toBe("accepted");
    });

    expect(said).toMatch(/provider accepted/i);
    expect(said).not.toContain("owner@example.com");
    expect(said).not.toContain("token=abc");
  });

  it("does not throw when the provider refuses, because somebody is mid-registration", async () => {
    // Every send happens beside something a person just did successfully, so a
    // provider failure must not become an error page on top of it.
    const sending = await provider(422);
    const postman = postmanFor({
      mailUrl: sending.url,
      mailApiKey: "re_a_real_looking_key",
      mailFrom: "Agentify <no-reply@mail.example.com>",
    });

    const said = await logged(async () => {
      // Answered rather than thrown: nothing reached anybody, so nothing above
      // may say it did.
      await expect(postman(MESSAGE)).resolves.toBe("refused");
    });

    expect(said).toContain("422");
    expect(said).not.toContain("owner@example.com");
    expect(said).not.toContain("token=abc");
    // A second line claiming the message went out would send a reader to a
    // mailbox that will never hold it.
    expect(said).not.toMatch(/handed to the mail provider|was sent/);
  });

  it("does not throw when nothing answers at all", async () => {
    // A port with nothing behind it: a provider that is down.
    const sending = await provider();
    await sending.close();
    const postman = postmanFor({
      mailUrl: sending.url,
      mailApiKey: "re_a_real_looking_key",
      mailFrom: "Agentify <no-reply@mail.example.com>",
    });

    const said = await logged(async () => {
      await expect(postman(MESSAGE)).resolves.toBe("refused");
    });

    expect(said).toContain("could not be reached");
    expect(said).not.toContain("owner@example.com");
    // The link is worth something on its own, and an exception from a failed
    // request carries the whole document it was sending.
    expect(said).not.toContain("token=abc");
  });

  it("refuses a provider that stays silent past the fixed deadline", async () => {
    const sending = await provider(200, 250);
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    const deadline = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => nativeTimeout(50));
    const postman = postmanFor({
      mailUrl: sending.url,
      mailApiKey: "re_a_real_looking_key",
      mailFrom: "Agentify <no-reply@mail.example.com>",
    });

    try {
      await expect(postman(MESSAGE)).resolves.toBe("refused");
    } finally {
      deadline.mockRestore();
    }
  });
});
