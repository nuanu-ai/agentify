/**
 * A stand-in for Postgres on a loopback port: enough of the protocol for `pg`
 * to connect without a password and have each statement answered, and then to
 * lose every connection at once from the database's side, the way a restart,
 * a failover or a proxy closing idle connections leaves a pool. A statement is
 * answered with no rows, unless it is a simple query (one sent without values)
 * a test gave a row for, or one it is refusing for now, which fails as a
 * statement the database's user may not run. Nothing it is sent is checked.
 */

import { once } from "node:events";
import { type AddressInfo, createServer, type Socket } from "node:net";

/** A simple query's text, matched, and the one row of text columns it is answered with. */
export type Answer = readonly [RegExp, Readonly<Record<string, string>>];

export interface FakePostgres {
  /** Its address, naming the user and the database a test looks for in a log. */
  readonly url: string;
  readonly port: number;
  readonly user: string;
  readonly database: string;
  /** Closes every connection it holds, as a database going away does. */
  drop(): void;
  /** The simple queries it refuses from now on, or none. */
  refusing: RegExp | undefined;
  /** How many connections it holds open. */
  connections(): number;
  close(): Promise<void>;
}

const SSL_REQUEST = 80_877_103;
const CANCEL_REQUEST = 80_877_102;

const message = (type: string, body: string | Buffer = ""): Buffer => {
  const payload = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  const header = Buffer.alloc(5);
  header.write(type, 0, "latin1");
  header.writeInt32BE(payload.length + 4, 1);
  return Buffer.concat([header, payload]);
};

const int16 = (value: number): Buffer => {
  const bytes = Buffer.alloc(2);
  bytes.writeInt16BE(value);
  return bytes;
};

const AUTHENTICATED = message("R", Buffer.alloc(4));
const READY = message("Z", "I");
const NO_ROWS = message("C", "SELECT 0\0");

/** What each message of the extended protocol, and a simple query, is answered with. */
const ANSWERS: Readonly<Record<string, Buffer>> = {
  Q: Buffer.concat([NO_ROWS, READY]),
  P: message("1"),
  B: message("2"),
  D: message("n"),
  E: NO_ROWS,
  C: message("3"),
  S: READY,
};

/** Insufficient privilege, as Postgres refuses a statement its user may not run. */
const REFUSED = Buffer.concat([
  message("E", "SERROR\0VERROR\0C42501\0Mpermission denied\0\0"),
  READY,
]);

const oneRow = (row: Readonly<Record<string, string>>): Buffer => {
  const columns = Object.entries(row);
  const described = columns.map(([name]) => {
    // No table, no column number, `text`, variable length, no modifier, as text.
    const field = Buffer.alloc(18);
    field.writeInt32BE(25, 6);
    field.writeInt16BE(-1, 10);
    field.writeInt32BE(-1, 12);
    return Buffer.concat([Buffer.from(`${name}\0`, "utf8"), field]);
  });
  const values = columns.map(([, value]) => {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.alloc(4);
    length.writeInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
  });
  return Buffer.concat([
    message("T", Buffer.concat([int16(columns.length), ...described])),
    message("D", Buffer.concat([int16(columns.length), ...values])),
    message("C", "SELECT 1\0"),
    READY,
  ]);
};

const converse = (
  socket: Socket,
  answers: readonly Answer[],
  refusing: () => RegExp | undefined,
): void => {
  let pending = Buffer.alloc(0);
  let started = false;
  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      if (!started) {
        // The first message has no type: its length, then what it asks for.
        if (pending.length < 8 || pending.length < pending.readInt32BE(0)) return;
        const code = pending.readInt32BE(4);
        pending = pending.subarray(pending.readInt32BE(0));
        if (code === CANCEL_REQUEST) {
          socket.end();
          return;
        }
        if (code === SSL_REQUEST) {
          socket.write("N");
        } else {
          started = true;
          socket.write(Buffer.concat([AUTHENTICATED, READY]));
        }
        continue;
      }
      if (pending.length < 5 || pending.length < pending.readInt32BE(1) + 1) return;
      const type = String.fromCharCode(pending[0] ?? 0);
      const body = pending.subarray(5, pending.readInt32BE(1) + 1);
      pending = pending.subarray(pending.readInt32BE(1) + 1);
      if (type === "X") {
        socket.end();
        return;
      }
      const text = type === "Q" ? body.subarray(0, -1).toString("utf8") : undefined;
      if (text !== undefined && refusing()?.test(text)) {
        socket.write(REFUSED);
        continue;
      }
      const row =
        text === undefined ? undefined : answers.find(([matches]) => matches.test(text))?.[1];
      const answer = row === undefined ? ANSWERS[type] : oneRow(row);
      if (answer !== undefined) socket.write(answer);
    }
  });
};

export async function fakePostgres(answers: readonly Answer[] = []): Promise<FakePostgres> {
  const sockets = new Set<Socket>();
  let refusing: RegExp | undefined;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    converse(socket, answers, () => refusing);
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const user = "scanner_owner_in_the_log";
  const database = "scanner_rows_in_the_log";
  const drop = () => {
    for (const socket of sockets) socket.destroy();
  };
  return {
    url: `postgresql://${user}@127.0.0.1:${port}/${database}`,
    port,
    user,
    database,
    drop,
    get refusing() {
      return refusing;
    },
    set refusing(statements) {
      refusing = statements;
    },
    connections: () => sockets.size,
    close: async () => {
      drop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
