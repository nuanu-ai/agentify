<?php
// The lab's download at prices whose tax does not split evenly, for the
// rounding question. Each is the Gift Message Templates product again, same
// file and class, under a SKU that names its price; running it again changes
// nothing.
$source = wc_get_product(wc_get_product_id_by_sku('DL-GIFT-MESSAGES'));
foreach (['0.99', '1.03', '1.06', '4.55', '9.99', '19.95', '33.33', '99.99'] as $price) {
    $sku = 'DL-GIFT-MESSAGES-' . str_replace('.', '', $price);
    if (wc_get_product_id_by_sku($sku)) {
        continue;
    }
    $copy = new WC_Product_Simple();
    $copy->set_name('Gift Message Templates at ' . $price);
    $copy->set_status('publish');
    $copy->set_sku($sku);
    $copy->set_regular_price($price);
    $copy->set_virtual(true);
    $copy->set_downloadable(true);
    $copy->set_downloads($source->get_downloads());
    $copy->set_download_limit(-1);
    $copy->set_download_expiry(-1);
    $copy->set_category_ids($source->get_category_ids());
    $copy->save();
}
echo "Awkward prices in place.\n";
