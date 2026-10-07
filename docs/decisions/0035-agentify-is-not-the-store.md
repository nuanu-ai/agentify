# 0035. Agentify is not the store: a product comes from the merchant's system, which hands it over

Date: 2026-10-07
Status: accepted (the product owner, 2026-10-07)

## Context

An outside contribution (nuanu-ai/agentify#28) added a form to the dashboard
where a merchant types a product in by hand and publishes it as a card. Its
author kept it off the test and live channels, because nothing could deliver
what such a card sells: an order goes to the merchant's own code through the
SDK, or to the worker that fills orders from a connected WooCommerce shop
(ADR-0023), and a merchant who typed a product in has neither. The way to
switch it on would have been for Agentify to deliver the goods itself, from
keys, links or files the merchant uploaded to us.

That is a different product. A store holds what it sells and answers for
handing it over. Agentify connects a merchant's existing system to the agents
that buy from it, and holds none of the money on the way (ADR-0019). Once it
holds the goods too, every kind of goods brings its own storage, delivery,
stock and refund questions, and the scope grows with the merchant's catalogue
rather than with the integration.

## Decision

A product exists in the merchant's own system before it is a card, and that
system hands it over: the merchant's code through the SDK, or their shop
through a connector Agentify runs on their behalf, where the shop keeps the
goods and delivers them by its own means (ADR-0023). The dashboard can import
a connected shop's products as cards and pause any card, but it has no form
that makes a product up. Agentify holds no goods for a merchant, neither
uploaded keys, links and files nor stock, and delivers nothing from a store
of its own.

A change that would have Agentify create a product, or hold or deliver goods,
changes this decision first, in this file.

## Consequences

The dashboard stays a window onto the merchant's system and its sales, and
the work a new kind of goods brings stays with the system that already sells
it. A merchant with no code and no supported shop cannot sell through
Agentify.

Rejected: a product typed into the dashboard and delivered by Agentify from
what the merchant uploaded, because it makes Agentify the store, with the
storage, delivery, stock and refunds of other people's goods. Rejected as
well: the same form kept in the code behind a switch and shown only on a
laptop, because code that no channel can use is kept just in case, which
AGENTS.md ("Code", delete first) refuses, and its presence invites switching
it on before the question above is answered.
