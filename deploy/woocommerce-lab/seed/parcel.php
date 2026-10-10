<?php

// One physical product and the shipping zones that price it, for trying a
// parcel through the Agentify connector (ADR-0023). It can be run on its own
// against a shop that already holds the rest of the seed, and running it again
// changes nothing: the product is found by its SKU and each zone by its name.
//
// The product is the second class the connector imports: a published,
// in-stock simple product in US dollars that is neither virtual nor
// downloadable, without managed stock and not sold individually. Its price is
// the goods alone; what shipping costs is WooCommerce's own answer for the
// buyer's locality, drawn from the zones below.
//
// The zones are matched in the order they are listed, the first match wins,
// and each is keyed by a different part of the locality an agent's price
// question carries: Bali by its state, the San Francisco postcodes by a
// postcode pattern, and the rest of Indonesia by its country alone. Indonesia
// has two rates, so that the connector's choice of the cheaper one is seen.
// Every other place falls to WooCommerce's own zone for locations not covered,
// which has no rate, and the shop does not ship there.

if (!defined('ABSPATH')) {
    exit(1);
}

$sku = 'PARCEL-TOTE-BAG';
$existing = wc_get_product_id_by_sku($sku);
$product = $existing ? wc_get_product($existing) : new WC_Product_Simple();
$product->set_name('Nuanu Tote Bag');
$product->set_slug('nuanu-tote-bag');
$product->set_status('publish');
$product->set_catalog_visibility('visible');
$product->set_description(
    '<p>A cotton canvas tote bag with long handles, posted folded in a padded envelope.</p>' .
    '<p>This is a product in a test shop. An order for it is posted by hand, if at all.</p>'
);
$product->set_short_description('A cotton canvas tote bag with long handles.');
$product->set_sku($sku);
$product->set_regular_price('20.00');
$product->set_virtual(false);
$product->set_downloadable(false);
$product->set_manage_stock(false);
$product->set_sold_individually(false);
$product->set_stock_status('instock');
$product->save();

function lab_zone(string $name, int $order, array $locations): WC_Shipping_Zone
{
    foreach (WC_Shipping_Zones::get_zones() as $found) {
        if ($found['zone_name'] === $name) {
            return new WC_Shipping_Zone($found['id']);
        }
    }
    $zone = new WC_Shipping_Zone();
    $zone->set_zone_name($name);
    $zone->set_zone_order($order);
    foreach ($locations as [$code, $type]) {
        $zone->add_location($code, $type);
    }
    $zone->save();
    return $zone;
}

function lab_flat_rate(WC_Shipping_Zone $zone, string $title, string $cost): void
{
    foreach ($zone->get_shipping_methods() as $method) {
        if ($method->id === 'flat_rate' && $method->get_title() === $title) {
            return;
        }
    }
    $instance = $zone->add_shipping_method('flat_rate');
    $method = WC_Shipping_Zones::get_shipping_method($instance);
    update_option($method->get_instance_option_key(), [
        'title' => $title,
        'tax_status' => 'none',
        'cost' => $cost,
    ]);
}

$bali = lab_zone('Bali', 1, [['ID:BA', 'state']]);
lab_flat_rate($bali, 'Bali courier', '3.00');

$san_francisco = lab_zone('San Francisco', 2, [['US', 'country'], ['941*', 'postcode']]);
lab_flat_rate($san_francisco, 'Standard', '7.50');

$indonesia = lab_zone('Indonesia', 3, [['ID', 'country']]);
lab_flat_rate($indonesia, 'Standard', '5.00');
lab_flat_rate($indonesia, 'Express', '12.00');

// Shipping on, to every country the shop sells to, and never forced to the
// billing address: a shop that forces it keeps no shipping address of its own,
// and the address an agent sends would vanish from the merchant's screens.
update_option('woocommerce_ship_to_countries', '');
if (get_option('woocommerce_ship_to_destination') === 'billing_only') {
    update_option('woocommerce_ship_to_destination', 'shipping');
}

echo 'Parcel product ' . $product->get_id() . ' and its shipping zones are in place.' . "\n";
