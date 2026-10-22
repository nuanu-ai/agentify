<?php

// The overlays: settings laid over whichever profile is active, without
// touching its catalogue, and the one overlay that grows the catalogue past the
// connector's limit. This file only defines them; overlay.php lays one over the
// shop, check.php reads the same definitions to check that it took, and the
// hard profile is built with the first tax mode below.

if (!defined('ABSPATH')) {
    exit(1);
}

// Indonesia's VAT (PPN) is 12% by law, charged since 1 January 2025 on a base of
// eleven twelfths of the price for goods that are not luxury goods (Minister of
// Finance Regulation 131/2024, article 3), so a shop charges 11% of the price.
// The lab README cites the sources. Exports are zero-rated, so no other country
// has a rate, as in research note 56.
const LAB_PPN_RATE = '11.0000';

// The number of products the Agentify connector imports at most. The
// over-limit overlay takes the shop one product past it.
const LAB_PRODUCT_LIMIT = 2000;

/** The rates every tax mode brings: PPN for Indonesia, applied to shipping too. */
function lab_tax_rates(): array
{
    return [[
        'tax_rate_country' => 'ID',
        'tax_rate_state' => '',
        'tax_rate' => LAB_PPN_RATE,
        'tax_rate_name' => 'PPN',
        'tax_rate_priority' => 1,
        'tax_rate_compound' => 0,
        'tax_rate_shipping' => 1,
        'tax_rate_order' => 0,
        'tax_rate_class' => '',
    ]];
}

/**
 * Each tax mode as the options it sets. All share research note 56's
 * Indonesian shop: based in Denpasar, Bali, with tax calculated and one rate
 * for Indonesia. The first is the one mode the connector sells from; each other
 * changes one thing about it, except prices entered before tax, which a shop of
 * that kind also shows before tax.
 */
function lab_tax_modes(): array
{
    $sells = [
        'woocommerce_default_country' => 'ID:BA',
        'woocommerce_store_city' => 'Denpasar',
        'woocommerce_store_postcode' => '80361',
        'woocommerce_calc_taxes' => 'yes',
        'woocommerce_prices_include_tax' => 'yes',
        'woocommerce_tax_display_shop' => 'incl',
        'woocommerce_tax_display_cart' => 'incl',
        'woocommerce_tax_based_on' => 'shipping',
        'woocommerce_tax_round_at_subtotal' => 'yes',
    ];
    return [
        'tax-incl' => $sells,
        'tax-excl' => array_merge($sells, [
            'woocommerce_prices_include_tax' => 'no',
            'woocommerce_tax_display_shop' => 'excl',
            'woocommerce_tax_display_cart' => 'excl',
        ]),
        'tax-per-line' => array_merge($sells, ['woocommerce_tax_round_at_subtotal' => 'no']),
        'tax-shop-shows-excl' => array_merge($sells, ['woocommerce_tax_display_shop' => 'excl']),
        'tax-cart-shows-excl' => array_merge($sells, ['woocommerce_tax_display_cart' => 'excl']),
        'tax-on-billing' => array_merge($sells, ['woocommerce_tax_based_on' => 'billing']),
        'tax-on-base' => array_merge($sells, ['woocommerce_tax_based_on' => 'base']),
    ];
}

/** Every overlay's name, the tax modes first. */
function lab_overlay_names(): array
{
    return array_merge(array_keys(lab_tax_modes()), ['over-limit']);
}

/** Replaces the shop's tax rates with the ones every tax mode brings. */
function lab_set_tax_mode(string $mode): void
{
    foreach (lab_tax_modes()[$mode] as $option => $value) {
        update_option($option, $value);
    }
    global $wpdb;
    foreach ($wpdb->get_col("SELECT tax_rate_id FROM {$wpdb->prefix}woocommerce_tax_rates") as $id) {
        WC_Tax::_delete_tax_rate((int) $id);
    }
    foreach (lab_tax_rates() as $rate) {
        WC_Tax::_insert_tax_rate($rate);
    }
    WC_Cache_Helper::invalidate_cache_group('taxes');
}

/** How many products the shop's public catalogue lists, as the connector counts them. */
function lab_listed_products(): int
{
    $request = new WP_REST_Request('GET', '/wc/store/v1/products');
    $request->set_param('per_page', 1);
    $response = rest_do_request($request);
    if ($response->is_error()) {
        throw new RuntimeException('The public catalogue did not answer: ' . $response->as_error()->get_error_message());
    }
    return (int) ($response->get_headers()['X-WP-Total'] ?? -1);
}
