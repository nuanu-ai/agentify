<?php

// Checks that the running shop is a profile, with the overlays named after it
// laid over it, and nothing else:
//
//   wp eval-file /seed/check.php <profile> [overlay ...]
//
// It reads the shop from the inside, so it needs no address and no network,
// and it prints every mismatch it finds before it fails, so a shop that is
// another profile shows how it differs. The expectations below are written out
// rather than read from the scripts that build the profiles, so that a change
// to a seed that alters a profile fails here until this file says so too.

if (!defined('ABSPATH')) {
    exit(1);
}
require __DIR__ . '/overlays.php';
require_once ABSPATH . 'wp-admin/includes/plugin.php';

// The hard profile's make-up, as its seed generates it.
const HARD_VARIABLE = 499;
const HARD_VARIATIONS = 2250;
const HARD_UNPRICED = 69;
const HARD_OUT_OF_STOCK = 117;
const HARD_ON_SALE = 244;
const HARD_SOLD_INDIVIDUALLY = 79;
const HARD_MANAGED_STOCK = 398;

$profile = $args[0] ?? '';
$overlays = array_slice($args, 1);

$plugins = [];
foreach (file(__DIR__ . '/plugins.txt', FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
    if ($line[0] !== '#') {
        [$slug, $version] = explode('@', $line);
        $plugins[$slug] = $version;
    }
}

$basic_skus = ['GIFT-COFFEE-25', 'GIFT-DINNER-90', 'GIFT-WELLNESS-75', 'PASS-CREATIVE-50', 'GIFT-WEEKEND-150', 'DL-GIFT-MESSAGES', 'DL-WRAPPING-GUIDE', 'PARCEL-TOTE-BAG'];
$downloads = ['DL-GIFT-MESSAGES' => 'gift-message-templates.txt', 'DL-WRAPPING-GUIDE' => 'gift-wrapping-guide.txt'];
$connector_settings = [
    'woocommerce_file_download_method' => 'force',
    'woocommerce_downloads_redirect_fallback_allowed' => 'no',
    'woocommerce_downloads_require_login' => 'no',
    'woocommerce_downloads_grant_access_after_payment' => 'yes',
];
$realistic = [
    'listed' => 113, 'variable' => 29, 'variations' => 124, 'unpriced' => 4, 'out_of_stock' => 7,
    'on_sale' => 15, 'sold_individually' => 5, 'managed_stock' => 24, 'downloadable' => 0,
    'plugins' => $plugins, 'gateways' => ['bacs'], 'mu_plugins' => ['lab-mail-catcher.php'],
    'tax_mode' => null, 'downloads' => [],
];
$lab_zones = static fn (string $status, callable $cost) => [
    "Bali [ID:BA state]: Bali courier {$cost(3)} ($status)",
    "San Francisco [941* postcode, US country]: Standard {$cost(7.5)} ($status)",
    "Indonesia [ID country]: Standard {$cost(5)} ($status), Express {$cost(12)} ($status)",
];
$usd = static fn (float $dollars) => number_format($dollars, 2, '.', '');
$rupiah = static fn (float $dollars) => (string) (int) ($dollars * 16000);

$profiles = [
    'basic' => [
        'options' => $connector_settings + [
            'blogname' => 'Test Gift Shop', 'woocommerce_currency' => 'USD', 'woocommerce_price_num_decimals' => '2',
        ],
        'listed' => 8, 'variable' => 0, 'variations' => 0, 'unpriced' => 0, 'out_of_stock' => 0,
        'on_sale' => 0, 'sold_individually' => 0, 'managed_stock' => 0, 'downloadable' => 2,
        'skus' => $basic_skus,
        'prices' => ['PARCEL-TOTE-BAG' => '20.00', 'DL-GIFT-MESSAGES' => '1.00', 'DL-WRAPPING-GUIDE' => '2', 'GIFT-WEEKEND-150' => '150.00'],
        'zones' => $lab_zones('none', $usd),
        'plugins' => [], 'gateways' => [], 'mu_plugins' => [], 'tax_mode' => null, 'downloads' => $downloads,
    ],
    'realistic' => $realistic + [
        'options' => [
            'blogname' => 'Test Lifestyle Shop', 'woocommerce_currency' => 'IDR', 'woocommerce_price_num_decimals' => '0',
            'woocommerce_price_thousand_sep' => '.', 'woocommerce_price_decimal_sep' => ',',
        ],
        'prices' => ['PAN-01' => '2000', 'FUR-12' => '40500000', 'FUR-13' => ''],
        'zones' => ['Indonesia [ID country]: Regular courier 24000 (none)'],
    ],
    'realistic-usd' => $realistic + [
        'options' => [
            'blogname' => 'Test Lifestyle Shop', 'woocommerce_currency' => 'USD', 'woocommerce_price_num_decimals' => '2',
            'woocommerce_price_thousand_sep' => ',', 'woocommerce_price_decimal_sep' => '.',
        ],
        'prices' => ['PAN-01' => '0.13', 'FUR-12' => '2531.25', 'FUR-13' => ''],
        'zones' => ['Indonesia [ID country]: Regular courier 1.50 (none)'],
    ],
    'hard' => [
        'options' => $connector_settings + [
            'blogname' => 'Test Lifestyle Shop', 'woocommerce_currency' => 'IDR', 'woocommerce_price_num_decimals' => '0',
            'woocommerce_price_thousand_sep' => '.', 'woocommerce_price_decimal_sep' => ',',
        ],
        'listed' => 1950, 'variable' => HARD_VARIABLE, 'variations' => HARD_VARIATIONS, 'unpriced' => HARD_UNPRICED,
        'out_of_stock' => HARD_OUT_OF_STOCK, 'on_sale' => HARD_ON_SALE, 'sold_individually' => HARD_SOLD_INDIVIDUALLY,
        'managed_stock' => HARD_MANAGED_STOCK, 'downloadable' => 2,
        'prices' => ['PAN-01' => '2000', 'FUR-12' => '40500000', 'DL-GIFT-MESSAGES' => '16000', 'DL-WRAPPING-GUIDE' => '32000', 'FUR-H0004' => ''],
        'zones' => $lab_zones('taxable', $rupiah),
        'plugins' => $plugins, 'gateways' => ['bacs'], 'mu_plugins' => ['lab-mail-catcher.php'],
        'tax_mode' => 'tax-incl', 'downloads' => $downloads,
    ],
];

if (!isset($profiles[$profile])) {
    fwrite(STDERR, 'No profile is called "' . $profile . '". The profiles are: ' . implode(', ', array_keys($profiles)) . "\n");
    exit(2);
}
foreach ($overlays as $overlay) {
    if (!in_array($overlay, lab_overlay_names(), true)) {
        fwrite(STDERR, 'No overlay is called "' . $overlay . "\"\n");
        exit(2);
    }
}
$want = $profiles[$profile];
foreach ($overlays as $overlay) {
    if (isset(lab_tax_modes()[$overlay])) {
        $want['tax_mode'] = $overlay;
    }
}
$over_limit = in_array('over-limit', $overlays, true);

// WP-CLI runs this file inside a function, so the count lives in $GLOBALS
// rather than in a variable of this file.
$GLOBALS['lab_mismatches'] = 0;
function lab_expect(string $what, $found, $wanted): void
{
    if ($found === $wanted) {
        echo "ok    $what\n";
        return;
    }
    $GLOBALS['lab_mismatches']++;
    $show = static fn ($value) => is_array($value) ? implode('; ', $value) : var_export($value, true);
    echo "FAIL  $what\n        wanted: {$show($wanted)}\n        found:  {$show($found)}\n";
}

global $wpdb;
$published = "SELECT ID FROM {$wpdb->posts} WHERE post_type = 'product' AND post_status = 'publish'";
$count = static fn (string $sql) => (int) $wpdb->get_var($sql);
$meta_count = static fn (string $key, string $value) => $count(
    "SELECT COUNT(*) FROM {$wpdb->postmeta} WHERE meta_key = '$key' AND meta_value = '$value' AND post_id IN ($published)"
);
$typed = static fn (string $type) => $count(
    "SELECT COUNT(*) FROM {$wpdb->term_relationships} r
     JOIN {$wpdb->term_taxonomy} t ON t.term_taxonomy_id = r.term_taxonomy_id AND t.taxonomy = 'product_type'
     JOIN {$wpdb->terms} n ON n.term_id = t.term_id AND n.slug = '$type'
     WHERE r.object_id IN ($published)"
);

lab_expect('the shop says it was built as this profile', get_option('agentify_lab_profile'), $profile);
lab_expect('the overlays it records', array_values((array) get_option('agentify_lab_overlays', [])), array_values($overlays));

$copies = $count("SELECT COUNT(*) FROM {$wpdb->postmeta} WHERE meta_key = '_sku' AND meta_value LIKE 'OVER-LIMIT-%'");
lab_expect('products in the public catalogue', lab_listed_products(), $over_limit ? LAB_PRODUCT_LIMIT + 1 : $want['listed']);
lab_expect('copies made by over-limit', $copies, $over_limit ? LAB_PRODUCT_LIMIT + 1 - $want['listed'] : 0);
lab_expect('variable products', $typed('variable'), $want['variable']);
lab_expect('variations', $count("SELECT COUNT(*) FROM {$wpdb->posts} WHERE post_type = 'product_variation' AND post_parent IN ($published)"), $want['variations']);
lab_expect('simple products without a price', $typed('simple') - $count(
    "SELECT COUNT(*) FROM {$wpdb->postmeta} WHERE meta_key = '_regular_price' AND meta_value <> '' AND post_id IN ($published)"
), $want['unpriced']);
lab_expect('products out of stock', $meta_count('_stock_status', 'outofstock'), $want['out_of_stock']);
lab_expect('products on sale', $count(
    "SELECT COUNT(*) FROM {$wpdb->postmeta} WHERE meta_key = '_sale_price' AND meta_value <> '' AND post_id IN ($published)"
), $want['on_sale']);
lab_expect('products sold one at a time', $meta_count('_sold_individually', 'yes'), $want['sold_individually']);
lab_expect('products counting their stock', $meta_count('_manage_stock', 'yes'), $want['managed_stock']);
lab_expect('downloadable products', $meta_count('_downloadable', 'yes'), $want['downloadable']);

if (isset($want['skus'])) {
    $skus = $wpdb->get_col("SELECT meta_value FROM {$wpdb->postmeta} WHERE meta_key = '_sku' AND meta_value NOT LIKE 'OVER-LIMIT-%' AND post_id IN ($published) ORDER BY meta_value");
    $wanted_skus = $want['skus'];
    sort($wanted_skus);
    lab_expect('the products, by SKU', $skus, $wanted_skus);
}
$prices = [];
foreach ($want['prices'] as $sku => $price) {
    $product = wc_get_product(wc_get_product_id_by_sku($sku));
    $prices[$sku] = $product ? $product->get_regular_price() : 'missing';
}
lab_expect('regular prices of ' . implode(', ', array_keys($want['prices'])), $prices, $want['prices']);

$hashes = [];
$wanted_hashes = [];
foreach ($want['downloads'] as $sku => $file) {
    $product = wc_get_product(wc_get_product_id_by_sku($sku));
    $files = $product ? array_values($product->get_downloads()) : [];
    $path = trailingslashit(wp_upload_dir()['basedir']) . 'woocommerce_uploads/' . $file;
    $hashes[$sku] = count($files) === 1 && str_ends_with($files[0]->get_file(), '/woocommerce_uploads/' . $file) && is_readable($path)
        ? hash_file('sha256', $path) : 'no protected file';
    $wanted_hashes[$sku] = hash_file('sha256', __DIR__ . '/downloads/' . $file);
}
lab_expect('each download carries its seed file', $hashes, $wanted_hashes);

$options = [];
foreach ($want['options'] as $option => $value) {
    $options[$option] = (string) get_option($option);
}
lab_expect('shop settings ' . implode(', ', array_keys($want['options'])), $options, $want['options']);

// The tax settings and rates: those of the tax mode the profile or its last
// tax overlay sets, or none, with tax calculation off.
$wanted_tax = $want['tax_mode'] ? lab_tax_modes()[$want['tax_mode']] : ['woocommerce_calc_taxes' => 'no'];
$tax_options = [];
foreach ($wanted_tax as $option => $value) {
    $tax_options[$option] = (string) get_option($option);
}
lab_expect('tax settings' . ($want['tax_mode'] ? ' of ' . $want['tax_mode'] : ', calculation off'), $tax_options, $wanted_tax);
$rate_line = static fn (array $rate) => sprintf(
    '%s %s %s %s%% priority %d%s%s',
    $rate['tax_rate_country'] ?: '*', $rate['tax_rate_state'] ?: '*', $rate['tax_rate_name'], $rate['tax_rate'],
    $rate['tax_rate_priority'], $rate['tax_rate_compound'] ? ' compound' : '', $rate['tax_rate_shipping'] ? ' with shipping' : ''
);
$rates = array_map($rate_line, $wpdb->get_results("SELECT * FROM {$wpdb->prefix}woocommerce_tax_rates ORDER BY tax_rate_order, tax_rate_id", ARRAY_A));
$rate_locations = (int) $wpdb->get_var("SELECT COUNT(*) FROM {$wpdb->prefix}woocommerce_tax_rate_locations");
lab_expect('tax rates', array_merge($rates, $rate_locations ? ["$rate_locations postcode or city limits"] : []), $want['tax_mode'] ? array_map($rate_line, lab_tax_rates()) : []);

$zones = [];
foreach (WC_Shipping_Zones::get_zones() as $found) {
    $zone = new WC_Shipping_Zone($found['id']);
    $places = array_map(static fn ($location) => $location->code . ' ' . $location->type, $zone->get_zone_locations());
    sort($places);
    $methods = [];
    foreach ($zone->get_shipping_methods() as $method) {
        $methods[] = sprintf('%s %s (%s)', $method->get_title(), $method->get_option('cost'), $method->get_option('tax_status'));
    }
    $zones[] = sprintf('%s [%s]: %s', $zone->get_zone_name(), implode(', ', $places), implode(', ', $methods));
}
$rest_of_world = (new WC_Shipping_Zone(0))->get_shipping_methods();
if ($rest_of_world) {
    $zones[] = 'Locations not covered by other zones: ' . count($rest_of_world) . ' methods';
}
lab_expect('shipping zones', $zones, $want['zones']);

$active = [];
foreach ((array) get_option('active_plugins') as $file) {
    $slug = dirname($file);
    if ($slug !== 'woocommerce') {
        $active[$slug] = get_plugin_data(WP_PLUGIN_DIR . '/' . $file, false, false)['Version'];
    }
}
ksort($active);
$wanted_plugins = $want['plugins'];
ksort($wanted_plugins);
lab_expect('active plugins besides WooCommerce, with versions', $active, $wanted_plugins);
$enabled = [];
foreach (WC()->payment_gateways()->payment_gateways() as $gateway) {
    if ($gateway->enabled === 'yes') {
        $enabled[] = $gateway->id;
    }
}
lab_expect('enabled payment methods', $enabled, $want['gateways']);
$mu = array_values(array_map('basename', glob(WPMU_PLUGIN_DIR . '/*.php') ?: []));
lab_expect('must-use plugins', $mu, $want['mu_plugins']);

if ($GLOBALS['lab_mismatches']) {
    WP_CLI::error(sprintf('The shop is not the %s profile%s: %d mismatches.', $profile, $overlays ? ' with ' . implode(', ', $overlays) : '', $GLOBALS['lab_mismatches']));
}
WP_CLI::success(sprintf('The shop is the %s profile%s.', $profile, $overlays ? ' with ' . implode(', ', $overlays) : ''));
