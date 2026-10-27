# 0006. What the contract version promises, and when it moves

Date: 2026-08-27
Status: accepted; compatible-worker admission approved by the product owner,
2026-10-27

## Context

A merchant's process reads every gateway answer through the SDK, and each poll
request and answer name the contract their side understands. The product
owner's criterion is a small, reliable SDK that refuses early when it cannot
carry a purchase through. Delivering wrongly in silence is unacceptable; a
loud stop is acceptable. The storefront's reader is a stranger's agent no
handshake reaches.

## Decision

1. The version promises a vocabulary whose fields and words keep their names
   and meanings. The SDK ignores a field it does not know in what only
   informs. It reads an order's `status` or `payment_status`, an event's
   `reason`, a call's `result` or a price question's `purpose` it does not
   know as the reserved `unknown`, and skips an event of an unknown kind or a
   question of an unknown purpose with one non-fatal problem. Events may be
   lost anyway; the open-orders list is where a paid order stays. What an order
   delivers (product, parameters, price, address, test flag), off the stream or
   read back, is read closed: an unknown field or address shape fails the poll
   or the read. The gateway writes closed, so a leaked field fails on our side.
2. The version is `"5"`. It moves when a field or a word is renamed or removed,
   a field's meaning changes, or a field or shape is added to what the merchant
   delivers or prices: an order's core, anything at the top of an order read,
   which is kept closed, and a price question's contents, where an older SDK
   would drop the field. It moves too for a new card mode, selling state or kind
   of message on the stream, work or configuration an older SDK cannot do.
   Only informational additions leave it alone. The poll request requires
   `contract_version`, supplied by the SDK without merchant configuration.
   A request naming another version returns the gateway's version and no work;
   it draws nothing and establishes no worker contact. The SDK stops after its
   running handlers answer or its stop's wait runs out. A missing version is
   refused with an SDK update instruction. An unreadable answer remains a
   reported failed poll and never establishes agreement.
   Worker contact is stored with its contract version. Only contact speaking
   the running gateway's version opens sales, including after a restart or
   upgrade; an unversioned contact establishes none. Publishing before a worker
   connects is allowed. The first compatible poll opens sales automatically,
   subject to the ordinary selling rules. An incompatible worker does not
   erase another compatible worker's contact. Already accepted orders remain
   queued for compatible workers, and their handlers may still finish them.
3. Every SDK call names its release in `user-agent` as `agentify-sdk/<version>`,
   and the gateway notes it beside a key's last use whenever it writes that
   down, so the team sees who runs what. Nothing refuses a call on it.
4. `/v0/` names the merchant's API and moves the day that surface changes
   shape, independently of `CONTRACT_VERSION`. Every JSON Schema the contracts
   package renders is `urn:agentify:contract:${CONTRACT_VERSION}:${name}`.
5. The storefront carries no version. Its catalog, purchase address and order
   status live at `/x402/…`, because a discovery catalog keys a listing on its
   address, and protocol evolution rides in the challenge's `x402Version`
   (`docs/research/04-spike-bazaar-listing.md`); a version segment would
   retire a listed resource on each move. Its vocabularies are open strings
   with their known values listed, its documents take fields added later, and
   the gateway holds what it writes to closed forms of its own. A declared
   field's type stays closed: a card an agent cannot fill in is passed over.

## Alternatives rejected

A closed reader, the earlier rule: every new field or word moved the version
and stopped every merchant who had not upgraded, in lockstep with our release,
for changes they lose nothing by ignoring. A reader lenient everywhere: it
would deliver an order narrowed, a pickup point as a bare locality or a
quantity of three as one, without a word. An open string type for unknown
words: one reserved literal keeps a list a merchant can switch over. Refusing
old releases by `user-agent`: nothing in the product needs it yet.
