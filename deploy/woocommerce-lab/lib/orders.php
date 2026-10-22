<?php
// Run by `./lab.sh orders [<Agentify order id>]` through wp eval-file. It
// counts the shop's orders by status, the bin included, and, given an Agentify
// order identifier, lists every order that carries it: in the
// agentify_order_id line the connector writes, or as its transaction, with
// the agentify_ lines the connector wrote on it and its fee lines. It reads
// the orders through WooCommerce, so it sees them wherever the shop keeps them,
// and it changes nothing. It exits 3 when it was asked about an identifier and
// no order carries it, which is an answer; a shop it could not ask is a
// failure of wp itself.

$asked = $args[0] ?? null;

$statuses = array_merge(array_keys(wc_get_order_statuses()), ['trash']);
$ids = wc_get_orders(['limit' => -1, 'type' => 'shop_order', 'status' => $statuses, 'return' => 'ids', 'orderby' => 'ID', 'order' => 'ASC']);

$by_status = [];
$carrying = [];
foreach ($ids as $id) {
    $order = wc_get_order($id);
    if (!$order) {
        continue;
    }
    $status = $order->get_status();
    $by_status[$status] = ($by_status[$status] ?? 0) + 1;
    if ($asked === null) {
        continue;
    }
    $tagged = array_values(array_filter(
        $order->get_meta('agentify_order_id', false),
        static fn ($meta) => $meta->value === $asked
    ));
    $as_transaction = $order->get_transaction_id() === $asked;
    if ($tagged || $as_transaction) {
        $carrying[] = [$order, count($tagged), $as_transaction];
    }
}

$total = array_sum($by_status);
ksort($by_status);
$counted = [];
foreach ($by_status as $status => $n) {
    $counted[] = "$n $status";
}
printf("The shop holds %d order%s%s.\n", $total, $total === 1 ? '' : 's', $total ? ': ' . implode(', ', $counted) : '');

if ($asked === null) {
    exit(0);
}
if (!$carrying) {
    printf("No order in the shop carries %s, as agentify_order_id or as its transaction.\n", $asked);
    exit(3);
}
printf("%d order%s carr%s %s:\n", count($carrying), count($carrying) === 1 ? '' : 's', count($carrying) === 1 ? 'ies' : 'y', $asked);
foreach ($carrying as [$order, $tagged, $as_transaction]) {
    $created = $order->get_date_created();
    $where = [];
    if ($tagged) {
        $where[] = $tagged === 1 ? 'agentify_order_id' : "agentify_order_id $tagged times";
    }
    if ($as_transaction) {
        $where[] = 'transaction';
    }
    printf(
        "  order %d (number %s): %s, total %s %s, created %s via %s; carries it as %s\n",
        $order->get_id(),
        $order->get_order_number(),
        $order->get_status(),
        $order->get_total(),
        $order->get_currency(),
        $created ? gmdate('Y-m-d\\TH:i:s\\Z', $created->getTimestamp()) : 'at no recorded time',
        $order->get_created_via() ?: 'nothing recorded',
        implode(' and ', $where)
    );
    foreach ($order->get_meta_data() as $meta) {
        if (str_starts_with($meta->key, 'agentify_') && is_scalar($meta->value)) {
            printf("    %s: %s\n", $meta->key, $meta->value);
        }
    }
    foreach ($order->get_fees() as $fee) {
        printf("    fee line %s: %s\n", $fee->get_name(), $fee->get_total());
    }
}
