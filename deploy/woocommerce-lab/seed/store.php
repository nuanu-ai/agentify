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

// The Agentify connector reads these six settings before it imports or sells a
// download, and refuses every product in the shop while any one of them
// differs: prices in US dollars, no tax calculated by WooCommerce, files
// streamed by WooCommerce itself rather than served from their address, no
// fallback that redirects a buyer to that address, no shop login between a
// buyer and the file, and access granted as soon as an order is paid.
update_option('woocommerce_currency', 'USD');
update_option('woocommerce_calc_taxes', 'no');
update_option('woocommerce_file_download_method', 'force');
update_option('woocommerce_downloads_redirect_fallback_allowed', 'no');
update_option('woocommerce_downloads_require_login', 'no');
update_option('woocommerce_downloads_grant_access_after_payment', 'yes');

wp_delete_post(1, true);
wp_delete_post(2, true);

function product_category(string $name, string $slug, string $description): int
{
    $term = term_exists($name, 'product_cat');
    if (!$term) {
        $term = wp_insert_term($name, 'product_cat', [
            'description' => $description,
            'slug' => $slug,
        ]);
    }
    if (is_wp_error($term)) {
        throw new RuntimeException($term->get_error_message());
    }
    return is_array($term) ? (int) $term['term_id'] : (int) $term;
}

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

/**
 * A file from the seed, placed where WooCommerce keeps protected downloads, as
 * the single download of a product.
 *
 * The connector refuses a file that answers a request without an order's
 * download permission. WooCommerce denies direct requests into
 * woocommerce_uploads, and its default approved download directories cover
 * that directory, so the file goes there rather than beside the product
 * photos. The identifier is derived from the address rather than random, so a
 * rebuilt baseline gives the same file the same identifier.
 */
function create_protected_download(string $filename): WC_Product_Download
{
    $source = '/seed/downloads/' . $filename;
    if (!is_readable($source)) {
        throw new RuntimeException('Download file is missing: ' . $filename);
    }

    $upload = wp_upload_dir();
    $directory = trailingslashit($upload['basedir']) . 'woocommerce_uploads';
    if (!wp_mkdir_p($directory)) {
        throw new RuntimeException('Could not create the protected upload directory');
    }
    if (!copy($source, trailingslashit($directory) . $filename)) {
        throw new RuntimeException('Could not copy download file: ' . $filename);
    }

    $url = trailingslashit($upload['baseurl']) . 'woocommerce_uploads/' . $filename;
    $download = new WC_Product_Download();
    $download->set_id(md5($url));
    $download->set_name($filename);
    $download->set_file($url);
    return $download;
}

function new_simple_product(array $item, int $category_id): WC_Product_Simple
{
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
    return $product;
}

// The gift cards promise a brunch, a dinner, a wellness day, a workshop and a
// weekend away. No file can deliver any of them, so they carry none, and the
// connector must name each one and leave it in the shop.
$gift_card_category = product_category(
    'Gift Cards',
    'gift-cards',
    'Digital gift cards for food, wellness, culture and travel.'
);
$gift_cards = [
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

// Each download is a plain-text file from seed/downloads, and the file is the
// whole of what the product promises. Together they are the one class of
// product the connector imports: a published, in-stock simple product in US
// dollars, virtual and downloadable, without managed stock, not sold
// individually, with exactly one protected file that can be downloaded any
// number of times and never expires. Prices carry two decimals, the form in
// which the public catalogue reports them, because the connector compares the
// protected price with the public one character for character.
$download_category = product_category(
    'Guides and Templates',
    'guides-and-templates',
    'Plain-text guides and templates, each delivered as one downloadable file.'
);
$downloads = [
    [
        'sku' => 'DL-GIFT-MESSAGES',
        'name' => 'Gift Message Templates',
        'price' => '1.00',
        'short' => 'Twenty short gift-card messages for five occasions, in one plain-text file.',
        'description' => '<p>Twenty short messages to write in a card that goes with a gift, four for each of five occasions: birthdays, thank-yous, weddings, new babies and sympathy.</p><p>Delivered as one plain-text file.</p>',
        'file' => 'gift-message-templates.txt',
    ],
    [
        'sku' => 'DL-WRAPPING-GUIDE',
        'name' => 'Gift Wrapping Guide',
        'price' => '2.00',
        'short' => 'Step-by-step instructions for wrapping a box and tying a bow, in one plain-text file.',
        'description' => '<p>Step-by-step instructions for wrapping a rectangular box neatly: what you need, how to measure and cut the paper, how to fold the sides and the ends, and how to tie a ribbon with a bow.</p><p>Delivered as one plain-text file.</p>',
        'file' => 'gift-wrapping-guide.txt',
    ],
];

foreach ($gift_cards as $item) {
    $product = new_simple_product($item, $gift_card_category);
    $product->set_image_id(create_product_image($item['image'], $item['name']));
    $product->save();
}

foreach ($downloads as $item) {
    $product = new_simple_product($item, $download_category);
    $product->set_manage_stock(false);
    $product->set_sold_individually(false);
    $product->set_downloadable(true);
    $product->set_downloads([create_protected_download($item['file'])]);
    $product->set_download_limit(-1);
    $product->set_download_expiry(-1);
    $product->save();
}

echo "Seeded " . (count($gift_cards) + count($downloads)) . " products.\n";
