# Reporting a vulnerability

If you find a security problem in Agentify, report it privately through
GitHub: open the **Security** tab of this repository and choose **Report a
vulnerability**. The report reaches the maintainers alone, and the discussion
stays private until a fix is out. Please do not describe the problem in a
public issue, a pull request or anywhere else before then.

What counts is anything that lets someone take or misdirect money, read or
change another person's or another merchant's data, act as a merchant, an
operator or a buyer they are not, or make the system claim something false
about a payment or an order. This covers:

- the gateway: the storefront agents buy from under `/x402`, the merchant API
  under `/v0`, and the orders and payments behind them;
- the SDK and its contracts, published on npm as `@nuanu-ai/agentify` and
  `@nuanu-ai/agentify-contracts`;
- the site at `agentify.ad` and `test.agentify.ad`: the scanner, the merchant
  dashboard, the documentation and sign-in.

To try something out, use the test channel, `test.agentify.ad`, where
payments are made with test funds on Base Sepolia. Do not spend real money,
place orders with real merchants or touch anybody else's data on
`agentify.ad`.

A useful report says what you did, what happened, what you expected instead,
and which address, package version or commit it was against.
