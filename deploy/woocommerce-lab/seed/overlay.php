<?php

// Lays one overlay over the active profile:
//
//   wp eval-file /seed/overlay.php <name>
//
// A tax mode replaces any tax mode laid before it; over-limit adds copies of
// one product until the public catalogue lists one more than the connector's
// limit. The overlays laid since the last switch are kept in the shop's own
// settings, so that the lab's status and check can name them.

if (!defined('ABSPATH')) {
    exit(1);
}
require __DIR__ . '/overlays.php';

$name = $args[0] ?? '';
if (!in_array($name, lab_overlay_names(), true)) {
    fwrite(STDERR, 'No overlay is called "' . $name . '". The overlays are: ' . implode(', ', lab_overlay_names()) . "\n");
    exit(2);
}
$laid = (array) get_option('agentify_lab_overlays', []);

if (isset(lab_tax_modes()[$name])) {
    lab_set_tax_mode($name);
    $laid = array_values(array_filter($laid, static fn ($overlay) => !isset(lab_tax_modes()[$overlay])));
    echo 'Tax mode ' . $name . ' is set.' . "\n";
}

if ($name === 'over-limit') {
    // The copies are of the oldest priced simple product, so that the shop's
    // other products, and the numbers they were given, stay as they were.
    $source_id = (int) $GLOBALS['wpdb']->get_var(
        "SELECT p.ID FROM {$GLOBALS['wpdb']->posts} p
         JOIN {$GLOBALS['wpdb']->postmeta} m ON m.post_id = p.ID AND m.meta_key = '_regular_price' AND m.meta_value <> ''
         WHERE p.post_type = 'product' AND p.post_status = 'publish'
         ORDER BY p.ID LIMIT 1"
    );
    $source = $source_id ? wc_get_product($source_id) : null;
    if (!$source || !$source->is_type('simple')) {
        throw new RuntimeException('The shop has no priced simple product to copy.');
    }
    $listed = lab_listed_products();
    $wanted = LAB_PRODUCT_LIMIT + 1 - $listed;
    wp_defer_term_counting(true);
    for ($copy = 1; $copy <= $wanted; $copy++) {
        $product = new WC_Product_Simple();
        $product->set_props([
            'name' => sprintf('%s (copy %04d)', $source->get_name(), $copy),
            'slug' => sprintf('%s-copy-%04d', $source->get_slug(), $copy),
            'status' => 'publish',
            'catalog_visibility' => 'visible',
            'sku' => sprintf('OVER-LIMIT-%04d', $copy),
            'regular_price' => $source->get_regular_price(),
            'short_description' => $source->get_short_description(),
            'description' => $source->get_description(),
            'category_ids' => $source->get_category_ids(),
            'image_id' => $source->get_image_id(),
            'virtual' => $source->get_virtual(),
            'downloadable' => $source->get_downloadable(),
            'downloads' => $source->get_downloads(),
            'stock_status' => 'instock',
        ]);
        $product->save();
    }
    wp_defer_term_counting(false);
    printf("%d copies of %s added; the public catalogue lists %d products.\n", max(0, $wanted), $source->get_name(), lab_listed_products());
}

if (!in_array($name, $laid, true)) {
    $laid[] = $name;
}
update_option('agentify_lab_overlays', $laid, false);
wp_cache_flush();
