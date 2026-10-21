<?php
// Puts the probe shop into one tax mode:
//
//   wp eval-file /probe/mode.php <off|id|de|us> [none|taxable] [flat]
//
// off  the lab's own state: tax calculation off, no rates, the lab's zones.
// id   a shop in Bali, prices entered with Indonesia's VAT inside them.
// de   a shop in Berlin, prices entered with German VAT inside them, selling
//      to France at the French rate.
// us   a shop in Seattle, prices entered before Washington sales tax.
//
// The second word sets the tax status of every flat shipping rate; the third,
// `flat`, installs the one-line filter that keeps an inclusive price the same
// for every buyer. Every other tax setting stays at WooCommerce's default
// unless named here.

if (!defined('ABSPATH')) {
    exit(1);
}

$mode = $args[0] ?? '';
$shipping_tax = $args[1] ?? 'none';
$flat = ($args[2] ?? '') === 'flat';
if (!in_array($mode, ['off', 'id', 'de', 'us'], true) || !in_array($shipping_tax, ['none', 'taxable'], true)) {
    fwrite(STDERR, "usage: mode.php <off|id|de|us> [none|taxable] [flat]\n");
    exit(2);
}

global $wpdb;
foreach ($wpdb->get_col("SELECT tax_rate_id FROM {$wpdb->prefix}woocommerce_tax_rates") as $id) {
    WC_Tax::_delete_tax_rate((int) $id);
}

function probe_rate(string $country, string $state, string $postcodes, string $rate, string $name, int $priority): int
{
    $id = WC_Tax::_insert_tax_rate([
        'tax_rate_country' => $country,
        'tax_rate_state' => $state,
        'tax_rate' => $rate,
        'tax_rate_name' => $name,
        'tax_rate_priority' => $priority,
        'tax_rate_compound' => 0,
        'tax_rate_shipping' => 1,
        'tax_rate_order' => 0,
        'tax_rate_class' => '',
    ]);
    if ($postcodes !== '') {
        WC_Tax::_update_tax_rate_postcodes($id, $postcodes);
    }
    return $id;
}

// The zones the lab does not have are the probe's own, found by name.
foreach (WC_Shipping_Zones::get_zones() as $found) {
    if (in_array($found['zone_name'], ['Seattle', 'Germany', 'France'], true)) {
        (new WC_Shipping_Zone($found['id']))->delete();
    }
}

function probe_zone(string $name, int $order, array $locations, string $title, string $cost): void
{
    $zone = new WC_Shipping_Zone();
    $zone->set_zone_name($name);
    $zone->set_zone_order($order);
    foreach ($locations as [$code, $type]) {
        $zone->add_location($code, $type);
    }
    $zone->save();
    $instance = $zone->add_shipping_method('flat_rate');
    $method = WC_Shipping_Zones::get_shipping_method($instance);
    update_option($method->get_instance_option_key(), [
        'title' => $title,
        'tax_status' => 'none',
        'cost' => $cost,
    ]);
}

$base = [
    'off' => ['US:CA', 'San Francisco', '94105'],
    'id' => ['ID:BA', 'Denpasar', '80361'],
    'de' => ['DE:DE-BE', 'Berlin', '10115'],
    'us' => ['US:WA', 'Seattle', '98101'],
][$mode];
update_option('woocommerce_default_country', $base[0]);
update_option('woocommerce_store_city', $base[1]);
update_option('woocommerce_store_postcode', $base[2]);

$inclusive = in_array($mode, ['id', 'de'], true);
update_option('woocommerce_calc_taxes', $mode === 'off' ? 'no' : 'yes');
update_option('woocommerce_prices_include_tax', $inclusive ? 'yes' : 'no');
update_option('woocommerce_tax_display_shop', $inclusive ? 'incl' : 'excl');
update_option('woocommerce_tax_display_cart', $inclusive ? 'incl' : 'excl');
update_option('woocommerce_tax_based_on', 'shipping');
update_option('woocommerce_tax_round_at_subtotal', 'no');

if ($mode === 'id') {
    // PPN: 12% on a base of 11/12 of the price for ordinary goods, so 11% of
    // the price (PMK 131/2024). Exports are zero-rated, so no other country
    // has a rate.
    probe_rate('ID', '', '', '11.0000', 'PPN', 1);
}
if ($mode === 'de') {
    // Umsatzsteuer 19% (UStG section 12); TVA 20% for a French consumer once
    // the shop is past the EU's distance-selling threshold and charges the
    // buyer's rate through the One-Stop Shop.
    probe_rate('DE', '', '', '19.0000', 'MwSt.', 1);
    probe_rate('FR', '', '', '20.0000', 'TVA', 1);
    probe_zone('Germany', 0, [['DE', 'country']], 'Paket', '4.90');
    probe_zone('France', 0, [['FR', 'country']], 'Standard', '9.90');
}
if ($mode === 'us') {
    // Washington's state rate and Seattle's local rate (Department of
    // Revenue, Q4 2026: .0650 and .0405, combined .1055), entered as two
    // stacked rates. A seller without nexus elsewhere has no other rate.
    probe_rate('US', 'WA', '', '6.5000', 'WA State', 1);
    probe_rate('US', 'WA', '98101...98199', '4.0500', 'Seattle', 2);
    probe_zone('Seattle', 0, [['US', 'country'], ['981*', 'postcode']], 'Standard', '6.00');
}

foreach (WC_Shipping_Zones::get_zones() as $found) {
    foreach ((new WC_Shipping_Zone($found['id']))->get_shipping_methods() as $method) {
        if ($method->id !== 'flat_rate') {
            continue;
        }
        $settings = get_option($method->get_instance_option_key(), []);
        $settings['tax_status'] = $shipping_tax;
        update_option($method->get_instance_option_key(), $settings);
    }
}

$plugin = WP_CONTENT_DIR . '/mu-plugins/probe-flat-prices.php';
if ($flat) {
    wp_mkdir_p(dirname($plugin));
    file_put_contents($plugin, "<?php\nadd_filter('woocommerce_adjust_non_base_location_prices', '__return_false');\n");
} elseif (file_exists($plugin)) {
    unlink($plugin);
}

WC_Cache_Helper::invalidate_cache_group('taxes');
wp_cache_flush();
printf(
    "mode %s: base %s, calc_taxes %s, prices_include_tax %s, shipping %s, flat %s, rates %d\n",
    $mode,
    get_option('woocommerce_default_country'),
    get_option('woocommerce_calc_taxes'),
    get_option('woocommerce_prices_include_tax'),
    $shipping_tax,
    $flat ? 'yes' : 'no',
    (int) $wpdb->get_var("SELECT COUNT(*) FROM {$wpdb->prefix}woocommerce_tax_rates")
);
