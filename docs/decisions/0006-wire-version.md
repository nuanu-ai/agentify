# 0006. What the contract version promises, and when it moves

Date: 2026-08-27
Status: accepted; the reading rule rewritten on 2026-10-21

## Context

A merchant's process reads every gateway answer through the SDK, and each poll
answer names the gateway's `CONTRACT_VERSION`, which the SDK compares with its
own. The product owner's criterion for the SDK: it is simple and
understandable, creates minimum friction for an outside user, is built as a pit
of success, and is super reliable, with all of that reliability hidden under
the hood. The storefront's reader is a stranger's agent no handshake reaches.

## Decision

1. The version promises a vocabulary: every field and word it names keeps its
   name and meaning. Readers ignore what they do not know. The SDK drops a field
   it was not built with at any depth of any answer; reads an order's `status`
   or `payment_status`, an event's `reason` or an order call's `result` it does
   not know as the reserved `unknown`, which is none of the known words; and
   skips an event of a kind it does not know with one non-fatal problem naming
   it, handling the rest of the poll. An event may be lost under its own
   contract anyway; the list of open orders is the path a paid order cannot
   fall out of. The gateway writes closed: each answer is held to the closed
   schema before it is sent, so a leaked field fails on our side, not a shop's.
2. The version is `"3"`, and moves only when a field or a word is renamed or
   removed, or a field's meaning changes; an older SDK then stops at the first
   poll answer it can read, with no order in flight, saying it is out of date,
   and reports each one it cannot read as a failed poll naming the version. An
   added field, event kind, status, reason or result word leaves it alone. A
   word added to a list whose reader has no `unknown` (a card's mode or field
   type, a receipt's outcome, a selling state, a kind of message on the
   stream) names work or configuration an older SDK cannot do, so adding one
   moves the version. What no SDK worker reads moves nothing: the payout
   wallet's pending fields (ADR-0019), and the routes and refusal codes only
   the dashboard called (`docs/research/35-one-process.md`). The version moved
   once, from `"2"`, at the switch from strict to lenient reading.
3. Every SDK call names its release in `user-agent` as `agentify-sdk/<version>`,
   and the gateway keeps the last one seen beside each key's last use, so the
   team sees who runs what. Nothing refuses a call on it.
4. `/v0/` names the merchant's API and moves the day that surface changes
   shape; it and `CONTRACT_VERSION` do not derive from each other. Every JSON
   Schema the contracts package renders is identified as
   `urn:agentify:contract:${CONTRACT_VERSION}:${name}`.
5. The storefront carries no version. The catalog, the purchase address and the
   agent's order status live at `/x402/…`, because a discovery catalog keys a
   listing on its address, and protocol evolution rides in the challenge's
   `x402Version` (`docs/research/04-spike-bazaar-listing.md`). A version
   segment would retire a listed resource on each move for one a catalog lists
   only after its own first paid purchase. Its vocabularies are open strings
   with their known values listed: a card of an unknown mode is skipped and the
   page stands, and an unknown status is no ending, so the agent asks again
   without buying again. Its documents take fields added later, which an agent
   ignores, and the gateway holds what it writes to closed forms of its own.
   The type of a declared field stays a closed list: a card with a type an
   agent does not know cannot be filled in and is passed over.

## Alternatives rejected

A closed reader, the earlier rule: the SDK held every answer to the closed
schema, and each new field or word moved the version so an old worker stopped
with words. The contract was one exact list, and every addition stopped every
merchant who had not upgraded, in lockstep with our release, for changes they
lose nothing by ignoring. An open string type for unknown words: one reserved
literal keeps a list a merchant can switch over exhaustively. Refusing old
releases by `user-agent`: nothing in the product needs it yet.
