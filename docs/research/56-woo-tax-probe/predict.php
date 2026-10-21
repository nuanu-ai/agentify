<?php
// The predictions of docs/research/56-woo-tax-probe.md, computed by
// re-implementing the arithmetic WooCommerce 11.2.1 performs when wc/v3
// creates an order (abstract-wc-order.php calculate_totals, calculate_taxes and
// update_taxes; class-wc-tax.php calc_tax; wc_get_price_excluding_tax for a
// line posted without totals). It reads no shop.
//
//   docker run --rm -v "$PWD":/p:ro wordpress:cli-php8.3 php /p/predict.php

const HALF_UP = PHP_ROUND_HALF_UP;
const HALF_DOWN = PHP_ROUND_HALF_DOWN; // the tax rounding mode of an inclusive shop

function r6(float $x): float { return round($x, 6); }
/** wc_format_decimal() of a float: six decimals, as a stored line total keeps it. */
function stored(float $x): float { return (float) sprintf('%.6f', $x); }
/** WC_Tax::calc_inclusive_tax for regular rates. */
function tax_inside(float $gross, array $rates): float {
    $sum = array_sum($rates);
    $tax = 0.0;
    foreach ($rates as $rate) {
        $the = ($rate / 100) / (1 + $sum / 100);
        $tax += r6($gross - ($gross - $the * $gross));
    }
    return $tax;
}
/** A line's total as WooCommerce sets it when the body names no total. */
function ex_tax_line(float $price, array $base_rates): float {
    return $price - tax_inside($price, $base_rates);
}
/**
 * The order total: one product line taxed at $rates, an optional shipping
 * line taxed at $ship_rates.
 */
function order_total(float $line, array $rates, float $ship, array $ship_rates, int $mode, bool $subtotal): array {
    $line = stored($line);
    $tax = 0.0;
    foreach ($rates as $rate) {
        $t = r6($line * $rate / 100);
        $tax += $subtotal ? $t : round($t, 2, $mode);
    }
    $ship_tax = 0.0;
    foreach ($ship_rates as $rate) {
        $t = r6($ship * $rate / 100);
        $ship_tax += $subtotal ? $t : round($t, 2, $mode);
    }
    $items = $subtotal ? $line : round($line * 100) / 100;
    $total = round($items + round($ship, 2) + $tax + $ship_tax, 2);
    return [$total, $tax + $ship_tax];
}
function money(float $x): string { return number_format($x, 2, '.', ''); }

$downloads = ['1.00', '2', '0.99', '1.03', '1.06', '4.55', '9.99', '19.95', '33.33', '99.99'];
$parcels = ['20.00', '0.99', '19.95', '33.33'];

echo "Downloads, inclusive shops, at the shop's base location.\n";
echo "B0 = the connector's body today, B1 = no line totals, B2a/B2b = ex-tax totals at 2/6 decimals.\n";
foreach ([['id', [11]], ['de', [19]]] as [$shop, $rates]) {
    foreach ([false, true] as $subtotal) {
        printf("%s round_at_subtotal=%s\n", $shop, $subtotal ? 'yes' : 'no');
        foreach ($downloads as $p) {
            $P = (float) $p;
            $r = array_sum($rates);
            [$b0] = order_total($P, $rates, 0, [], HALF_DOWN, $subtotal);
            [$b1, $tax1] = order_total(ex_tax_line($P, $rates), $rates, 0, [], HALF_DOWN, $subtotal);
            [$b2a] = order_total(round($P / (1 + $r / 100), 2), $rates, 0, [], HALF_DOWN, $subtotal);
            [$b2b] = order_total(round($P / (1 + $r / 100), 6), $rates, 0, [], HALF_DOWN, $subtotal);
            printf("  %-6s B0 %-7s B1 %-7s (tax %s) B2a %-7s B2b %s\n", $p, money($b0), money($b1), money($tax1), money($b2a), money($b2b));
        }
    }
}

echo "\nDownloads, the Seattle shop (exclusive), taxed at its base: B0 and B1 alike.\n";
foreach ([false, true] as $subtotal) {
    printf("us round_at_subtotal=%s\n", $subtotal ? 'yes' : 'no');
    foreach ($downloads as $p) {
        [$t, $tax] = order_total((float) $p, [6.5, 4.05], 0, [], HALF_UP, $subtotal);
        printf("  %-6s total %-7s tax %s\n", $p, money($t), money($tax));
    }
}

echo "\nDownloads away from base, B1 (DE shop, buyer's rate 20%; ID shop, no rate).\n";
foreach ($downloads as $p) {
    $P = (float) $p;
    [$fr] = order_total(ex_tax_line($P, [19]), [20], 0, [], HALF_DOWN, false);
    [$abroad] = order_total(ex_tax_line($P, [11]), [], 0, [], HALF_DOWN, false);
    printf("  %-6s de->FR %-7s id->abroad %s\n", $p, money($fr), money($abroad));
}

echo "\nParcels, B1 plus the cheapest rate, per locality (round_at_subtotal=no).\n";
$cases = [
    ['id Bali, shipping untaxed', [11], [11], 3.00, [], HALF_DOWN],
    ['id Jakarta, shipping untaxed', [11], [11], 5.00, [], HALF_DOWN],
    ['id San Francisco, shipping untaxed', [11], [], 7.50, [], HALF_DOWN],
    ['id Bali, shipping taxable', [11], [11], 3.00, [11], HALF_DOWN],
    ['id Jakarta, shipping taxable', [11], [11], 5.00, [11], HALF_DOWN],
    ['id San Francisco, shipping taxable', [11], [], 7.50, [], HALF_DOWN],
    ['de Berlin, shipping taxable', [19], [19], 4.90, [19], HALF_DOWN],
    ['de Paris, shipping taxable', [19], [20], 9.90, [20], HALF_DOWN],
    ['us Seattle, shipping taxable', null, [6.5, 4.05], 6.00, [6.5, 4.05], HALF_UP],
    ['us Seattle, shipping untaxed', null, [6.5, 4.05], 6.00, [], HALF_UP],
    ['us San Francisco, shipping taxable', null, [], 7.50, [], HALF_UP],
];
foreach ($cases as [$name, $base, $rates, $ship, $ship_rates, $mode]) {
    $row = [];
    foreach ($parcels as $p) {
        $P = (float) $p;
        $line = $base === null ? $P : ex_tax_line($P, $base);
        [$t] = order_total($line, $rates, $ship, $ship_rates, $mode, false);
        $row[] = "$p -> " . money($t);
    }
    printf("  %-36s %s\n", $name, implode(', ', $row));
}

echo "\nEvery price from 0.01 to 1000.00 at the base location of an inclusive shop: how many miss the price.\n";
foreach ([5, 7, 8.1, 10, 11, 12, 16, 19, 20, 21, 22, 23, 24, 25, 27] as $r) {
    $missed = ['B1 per line' => 0, 'B1 at subtotal' => 0, 'B2a' => 0, 'B2b' => 0];
    for ($cents = 1; $cents <= 100000; $cents++) {
        $P = $cents / 100;
        $line = ex_tax_line($P, [$r]);
        if (abs(order_total($line, [$r], 0, [], HALF_DOWN, false)[0] - $P) > 0.001) $missed['B1 per line']++;
        if (abs(order_total($line, [$r], 0, [], HALF_DOWN, true)[0] - $P) > 0.001) $missed['B1 at subtotal']++;
        if (abs(order_total(round($P / (1 + $r / 100), 2), [$r], 0, [], HALF_DOWN, false)[0] - $P) > 0.001) $missed['B2a']++;
        if (abs(order_total(round($P / (1 + $r / 100), 6), [$r], 0, [], HALF_DOWN, false)[0] - $P) > 0.001) $missed['B2b']++;
    }
    printf("  rate %4s%%: %s\n", $r, implode(', ', array_map(fn ($k, $v) => "$k $v", array_keys($missed), $missed)));
}
