<?php

if (!defined('ABSPATH')) {
    exit(1);
}

WC_Install::create_pages();

update_option('blogname', 'Test Gift Shop');
update_option('blogdescription', 'Digital gifts and memorable experiences');
update_option('timezone_string', 'Asia/Makassar');
update_option('date_format', 'F j, Y');
update_option('show_on_front', 'page');
update_option('page_on_front', (int) get_option('woocommerce_shop_page_id'));
update_option('woocommerce_enable_guest_checkout', 'yes');
update_option('woocommerce_enable_checkout_login_reminder', 'no');

wp_delete_post(1, true);
wp_delete_post(2, true);

$term = term_exists('Gift Cards', 'product_cat');
if (!$term) {
    $term = wp_insert_term('Gift Cards', 'product_cat', [
        'description' => 'Digital gift cards for food, wellness, culture and travel.',
        'slug' => 'gift-cards',
    ]);
}
$category_id = is_array($term) ? (int) $term['term_id'] : (int) $term;

function create_product_image(string $filename, string $title): int
{
    $source = '/seed/images/' . $filename;
    if (!is_readable($source)) {
        throw new RuntimeException('Product image is missing: ' . $filename);
    }

    $upload = wp_upload_dir();
    $path = trailingslashit($upload['path']) . $filename;
    wp_mkdir_p($upload['path']);
    if (!copy($source, $path)) {
        throw new RuntimeException('Could not copy product image: ' . $filename);
    }

    $attachment_id = wp_insert_attachment([
        'post_mime_type' => 'image/webp',
        'post_title' => $title,
        'post_status' => 'inherit',
    ], $path);
    if (is_wp_error($attachment_id)) {
        throw new RuntimeException($attachment_id->get_error_message());
    }

    require_once ABSPATH . 'wp-admin/includes/image.php';
    update_attached_file($attachment_id, $path);
    wp_update_attachment_metadata(
        $attachment_id,
        wp_generate_attachment_metadata($attachment_id, $path)
    );
    return (int) $attachment_id;
}

$products = [
    [
        'sku' => 'GIFT-COFFEE-25',
        'name' => 'Coffee & Brunch Gift Card',
        'price' => '25.00',
        'short' => 'A digital gift card for coffee, pastries and a relaxed brunch.',
        'description' => '<p>Treat someone to an unhurried morning. This digital gift card can be used for coffee, fresh pastries or brunch from the seasonal menu.</p><p>Valid for twelve months from purchase. Any unused balance stays on the card until its expiry date.</p>',
        'image' => 'coffee-brunch.webp',
    ],
    [
        'sku' => 'GIFT-DINNER-90',
        'name' => 'Dinner for Two Gift Card',
        'price' => '90.00',
        'short' => 'An evening gift for two, redeemable against food and drinks.',
        'description' => '<p>A flexible dinner gift for two people. The balance can be used across the evening menu, including non-alcoholic drinks.</p><p>Valid for twelve months. Reservations remain subject to availability.</p>',
        'image' => 'dinner-for-two.webp',
    ],
    [
        'sku' => 'GIFT-WELLNESS-75',
        'name' => 'Wellness Day Gift Card',
        'price' => '75.00',
        'short' => 'A restorative day with a choice of selected wellness experiences.',
        'description' => '<p>Give time to slow down. This card can be redeemed against selected massages, movement classes and wellness sessions.</p><p>Valid for twelve months. Advance booking is required for treatments.</p>',
        'image' => 'wellness-day.webp',
    ],
    [
        'sku' => 'PASS-CREATIVE-50',
        'name' => 'Creative Workshop Pass',
        'price' => '50.00',
        'short' => 'A digital pass for one selected art, craft or design workshop.',
        'description' => '<p>A pass for a hands-on creative session led by a local maker. Choose from the available art, craft and design workshops.</p><p>Valid for six months. Workshop dates and capacity vary.</p>',
        'image' => 'creative-workshop.webp',
    ],
    [
        'sku' => 'GIFT-WEEKEND-150',
        'name' => 'Weekend Escape Gift Card',
        'price' => '150.00',
        'short' => 'A flexible contribution toward a weekend stay or experience.',
        'description' => '<p>Put a memorable weekend within reach. This digital card can be applied to participating stays and curated weekend experiences.</p><p>Valid for twelve months. Dates and accommodation remain subject to availability.</p>',
        'image' => 'weekend-escape.webp',
    ],
];

foreach ($products as $item) {
    $product = new WC_Product_Simple();
    $product->set_name($item['name']);
    $product->set_slug(sanitize_title($item['name']));
    $product->set_status('publish');
    $product->set_catalog_visibility('visible');
    $product->set_description($item['description']);
    $product->set_short_description($item['short']);
    $product->set_sku($item['sku']);
    $product->set_regular_price($item['price']);
    $product->set_virtual(true);
    $product->set_stock_status('instock');
    $product->set_category_ids([$category_id]);
    $product->set_image_id(create_product_image($item['image'], $item['name']));
    $product->save();
}

echo "Seeded " . count($products) . " products.\n";
