---
"@nuanu-ai/agentify-contracts": minor
---

The calls and documents about the key a dashboard holds are called by the
product's name for it. The two routes move from `/v0/keys/cabinet` to
`/v0/keys/dashboard`, `API_ROUTES.issue_cabinet_key` and
`API_ROUTES.forget_cabinet_key` become `issue_dashboard_key` and
`forget_dashboard_key`, `CabinetKeySchema` and `ForgottenCabinetKeySchema` become
`DashboardKeySchema` and `ForgottenDashboardKeySchema` (documents
`dashboard_key` and `forgotten_dashboard_key`), the types `CabinetKey` and
`ForgottenCabinetKey` become `DashboardKey` and `ForgottenDashboardKey`, and the
refusal codes `not_a_cabinet_key` and `key_made_for_a_cabinet` become
`not_a_dashboard_key` and `key_made_for_a_dashboard`. The old names are gone
rather than kept beside the new ones. These routes are not on the public origin
and only the dashboard calls them, so a merchant's own code is affected only if
it imports one of these names or matches one of the two refusal codes.
