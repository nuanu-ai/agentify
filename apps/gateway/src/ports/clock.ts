/**
 * The clock and the identifiers, which `@agentify/core` never produces for
 * itself so the same inputs always produce the same order. They are passed in
 * so a test can hold time still and name every order it makes.
 */

import { randomUUID } from "node:crypto";

/** The current instant, in milliseconds since the epoch. */
export type Clock = () => number;

/** A fresh identifier of the given kind. */
export type Ids = (kind: string) => string;

export const systemClock: Clock = () => Date.now();

/**
 * Identifiers prefixed with their kind. The rest is random so that nobody can
 * guess the next one or infer how much was sold.
 */
export const randomIds: Ids = (kind) => `${kind}_${randomUUID().replaceAll("-", "")}`;

/** The instant as an ISO 8601 timestamp, as every document on the wire has it. */
export const asTimestamp = (at: number): string => new Date(at).toISOString();
