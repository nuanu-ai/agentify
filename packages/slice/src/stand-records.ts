/**
 * The stand merchant's durable records, kept only when the stand is given a
 * directory for them.
 *
 * Two things are written there and they are counted apart on purpose: every
 * order handed to the handler appends a line to `arrivals.jsonl`, and every
 * order the handler answers gets one file holding that answer, which is the
 * merchant's effect. An order may arrive any number of times and has one
 * effect. Several stands pointed at one directory share that one effect.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { appendFile, link, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { HandlerAnswer, Order } from "@nuanu-ai/agentify";

/** One order's effect: the answer that goes back for it, and which stand wrote it. */
export interface Recorded {
  readonly order_id: string;
  readonly merchant_item_id: string;
  readonly answer: HandlerAnswer;
  readonly at: string;
  readonly port: number;
  readonly pid: number;
}

export interface StandRecords {
  readonly directory: string;
  /** Counts one arrival of an order, whatever is done with it afterwards. */
  arrived(order: Order): Promise<void>;
  /** The effect already recorded for this order, or null where there is none. */
  find(orderId: string): Promise<Recorded | null>;
  /**
   * Records this answer as the order's effect, unless another stand recorded
   * the order first. Either way it returns the record that stands, and says
   * whether it is this one.
   */
  keep(order: Order, answer: HandlerAnswer): Promise<{ recorded: Recorded; first: boolean }>;
}

/**
 * The file an order's record lives in. A hash, because an identifier may hold
 * any printable character, and `/` or `..` in a file name is a path.
 */
const recordNameOf = (orderId: string): string =>
  `${createHash("sha256").update(orderId).digest("hex")}.json`;

/** Opens, creating it if need be, the records directory of the stand listening on `port`. */
export const keepRecordsIn = (directory: string, port: number): StandRecords => {
  mkdirSync(directory, { recursive: true });
  const pid = process.pid;

  const find = async (orderId: string): Promise<Recorded | null> => {
    try {
      return JSON.parse(await readFile(join(directory, recordNameOf(orderId)), "utf8")) as Recorded;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };

  return {
    directory,
    async arrived(order) {
      const line = {
        order_id: order.id,
        merchant_item_id: order.merchant_item_id,
        at: new Date().toISOString(),
        port,
        pid,
      };
      await appendFile(join(directory, "arrivals.jsonl"), `${JSON.stringify(line)}\n`);
    },
    find,
    async keep(order, answer) {
      const recorded: Recorded = {
        order_id: order.id,
        merchant_item_id: order.merchant_item_id,
        answer,
        at: new Date().toISOString(),
        port,
        pid,
      };
      const named = join(directory, recordNameOf(order.id));
      // Written whole and flushed under a name of its own, then linked to the
      // record's name. A link refuses a name that exists where a rename would
      // replace it, so the first stand to record an order keeps it, and no
      // reader ever opens a record that is still being written.
      const writing = `${named}.${randomUUID()}.writing`;
      const file = await open(writing, "wx");
      try {
        await file.writeFile(`${JSON.stringify(recorded, null, 2)}\n`);
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await link(writing, named);
        return { recorded, first: true };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const standing = await find(order.id);
        if (standing === null) {
          throw new Error(
            `The record for order ${order.id} existed a moment ago and is gone: something removed it from ${directory}.`,
          );
        }
        return { recorded: standing, first: false };
      } finally {
        await unlink(writing);
      }
    },
  };
};
