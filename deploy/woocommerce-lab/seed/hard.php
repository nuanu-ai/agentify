<?php

// The hard profile, laid over the realistic profile in rupiah: its catalogue
// grown to just under the connector's product limit with the census's mix of
// products, the lab's two downloads priced in rupiah, tax calculated as the
// one mode the connector sells from, and the lab's parcel zones priced in
// rupiah and taxed. Every name, price and flag is derived from a product's
// position, so a rebuild gives the same shop.

if (!defined('ABSPATH')) {
    exit(1);
}
require __DIR__ . '/overlays.php';

// Just under the connector's limit of 2,000, so that an import reads the whole
// catalogue and the over-limit overlay has a few products to add.
const HARD_PRODUCTS = 1950;
const HARD_RUPIAH_PER_DOLLAR = 16000;

// The share of generated simple products, priced and in stock, put on sale so
// that 13% of the whole catalogue is, as the census measured: most products on
// sale are simple, and the realistic profile's fifteen are among them.
const HARD_ON_SALE_SHARE = 0.192;

if (get_option('woocommerce_currency') !== 'IDR' || count(wc_get_products(['limit' => -1, 'return' => 'ids', 'status' => 'publish'])) !== 113) {
    throw new RuntimeException('The hard profile is laid over the realistic profile in rupiah, and this shop is not it.');
}

function hard_round_rupiah(float $amount): int
{
    $step = $amount < 100000 ? 500 : ($amount < 1000000 ? 1000 : 50000);
    return max($step, (int) round($amount / $step) * $step);
}

/**
 * Whether the item at this position is one of a share of all items, spread
 * evenly: true for about `share` of positions, the same ones on every build.
 * The phase keeps one share from always falling on the items another does.
 */
function hard_every(int $position, float $share, float $phase): bool
{
    return floor(($position + 1) * $share + $phase) > floor($position * $share + $phase);
}

// Per category: the realistic profile's SKU prefix and term slug, how many of
// its products are variable, and the names the generated products are made
// from, each group a list of products and a list of what tells them apart.
$categories = [
    'PAN' => ['pantry-and-snacks', 0, 11, [[
        ['Sambal Matah', 'Sambal Bawang', 'Sambal Ijo', 'Shrimp Crackers', 'Tempeh Chips', 'Cassava Chips', 'Peanut Brittle', 'Palm Sugar', 'Rendang Spice Paste', 'Rawon Spice Paste', 'Sweet Soy Sauce', 'Shrimp Paste', 'Beef Floss', 'Melinjo Crackers', 'Durian Dodol', 'Wild Forest Honey'],
        ['100 g', '150 g', '200 g', '250 g', '500 g', '1 kg', 'Pack of 3', 'Pack of 5', 'Pack of 10', 'Gift Box', 'Refill Pouch', 'Jar'],
    ]]],
    'COF' => ['coffee-and-cacao', 4, 14, [
        [
            ['Gayo Arabica', 'Toraja Arabica', 'Kintamani Arabica', 'Flores Bajawa Arabica', 'Java Preanger Arabica', 'Lampung Robusta', 'Temanggung Robusta', 'Dampit Robusta'],
            ['Beans, 200 g', 'Beans, 500 g', 'Beans, 1 kg', 'Ground, 200 g', 'Ground, 500 g', 'Drip Bags, Pack of 5', 'Drip Bags, Pack of 10', 'Light Roast, 250 g', 'Medium Roast, 250 g', 'Dark Roast, 250 g', 'Gift Tin', 'Sampler Box', 'Green Beans, 1 kg', 'Espresso Blend, 500 g', 'Cold Brew Pack'],
        ],
        [
            ['Jasmine Tea', 'Black Tea', 'Green Tea', 'Lemongrass Tea', 'Ginger Tea', 'Butterfly Pea Tea'],
            ['20 Bags', '50 Bags', 'Loose Leaf, 100 g', 'Loose Leaf, 250 g', 'Gift Tin', 'Sampler Box', 'Refill Pouch', 'Loose Leaf, 1 kg'],
        ],
        [
            ['Dark Chocolate 70%', 'Dark Chocolate 85%', 'Milk Chocolate with Coconut', 'Cacao Nibs', 'Drinking Chocolate'],
            ['50 g', '100 g', '250 g', 'Pack of 3', 'Pack of 6', 'Gift Box', 'Bulk, 1 kg', 'Sampler', 'Bar Set', 'Refill Pouch', 'Tin', 'Jar'],
        ],
    ]],
    'BOD' => ['body-care', 2, 18, [[
        ['Lemongrass', 'Frangipani', 'Sandalwood', 'Coconut', 'Jasmine', 'Ylang-Ylang', 'Vetiver', 'Patchouli', 'Cinnamon', 'Turmeric', 'Coffee', 'Rose', 'Green Tea', 'Aloe Vera', 'Pandan', 'Charcoal'],
        ['Soap Bar', 'Body Scrub', 'Body Lotion', 'Massage Oil', 'Body Butter', 'Lip Balm', 'Shampoo Bar', 'Hand Cream', 'Face Mask', 'Bath Salt', 'Reed Diffuser', 'Scented Candle', 'Room Spray', 'Essential Oil, 10 ml', 'Hair Oil', 'Body Mist', 'Foot Balm', 'Bath Bomb', 'Deodorant Cream', 'Face Toner'],
    ]], ' '],
    'ACC' => ['phone-and-computer-accessories', 1, 12, [[
        ['USB-C Cable, 1 m', 'USB-C Cable, 2 m', 'Lightning Cable, 1 m', 'Phone Case', 'Phone Grip', 'Car Phone Holder', 'Desk Phone Holder', 'Laptop Stand', 'Laptop Sleeve, 13 inch', 'Laptop Sleeve, 15 inch', 'Wireless Mouse', 'Keyboard', 'Earphones', 'Wireless Earbuds', 'Bluetooth Speaker', 'Power Bank, 10,000 mAh', 'Power Bank, 20,000 mAh', 'Wall Charger, 20 W', 'Screen Protector', 'Cable Organiser'],
        ['Black', 'White', 'Grey', 'Navy', 'Sage', 'Sand', 'Terracotta', 'Olive', 'Pink', 'Blue'],
    ]]],
    'CLO' => ['clothing', 16, 20, [[
        ['Cotton T-Shirt', 'Long Sleeve Tee', 'Tank Top', 'Linen Shirt', 'Batik Cotton Shirt', 'Linen Shorts', 'Board Shorts', 'Linen Trousers', 'Wrap Skirt', 'Rayon Beach Dress', 'Kaftan', 'Jumpsuit', 'Hooded Sweatshirt', 'Knit Cardigan', 'Rayon Sarong', 'Bucket Hat', 'Kids\' Cotton T-Shirt', 'Linen Blazer', 'Batik Scarf'],
        ['Parang', 'Kawung', 'Mega Mendung', 'Truntum', 'Sekar Jagad', 'Lereng', 'Ceplok', 'Tambal', 'Black', 'White', 'Sand', 'Sage', 'Indigo', 'Terracotta', 'Olive', 'Natural', 'Navy', 'Rust'],
    ]]],
    'BAG' => ['bags', 5, 12, [[
        ['Batik Pouch', 'Leather Wallet', 'Laptop Sleeve', 'Water Hyacinth Clutch', 'Crochet Shoulder Bag', 'Straw Beach Bag', 'Woven Tote Bag', 'Seagrass Basket Bag', 'Macrame Bag', 'Canvas Backpack', 'Rattan Round Bag', 'Leather Crossbody Bag', 'Ata Grass Bag', 'Pandan Weave Tote', 'Canvas Tote Bag', 'Leather Belt Bag', 'Sling Bag', 'Travel Pouch', 'Cosmetic Pouch', 'Duffel Bag'],
        ['Black', 'Natural', 'Tan', 'Brown', 'Olive', 'Navy', 'Sand', 'Terracotta', 'Cream', 'Indigo'],
    ]]],
    'DEC' => ['home-decor', 1, 10, [[
        ['Rattan Pendant Lamp', 'Jute Floor Rug', 'Stoneware Plate', 'Stoneware Bowl', 'Stoneware Mug', 'Ceramic Vase', 'Macrame Wall Hanging', 'Teak Wall Mirror', 'Brass Table Lamp', 'Cotton Hammock', 'Rattan Floor Lamp', 'Carved Teak Wall Panel', 'Coconut Shell Bowl', 'Bamboo Tray', 'Woven Placemat', 'Cushion Cover', 'Ikat Throw', 'Seagrass Basket', 'Teak Candle Holder'],
        ['Small', 'Medium', 'Large', 'Natural', 'Black', 'White', 'Set of 2', 'Set of 4', 'Set of 6'],
    ]]],
    'FUR' => ['furniture', 0, 16, [[
        ['Teak Side Table', 'Rattan Armchair', 'Teak Bench', 'Teak Bookshelf', 'Rattan Lounge Chair', 'Teak Coffee Table', 'Teak Sideboard', 'Rattan Sofa, Two Seats', 'Teak Daybed', 'Teak Bed Frame', 'Teak Dining Table', 'Teak Dining Chair', 'Rattan Bar Stool', 'Teak Console Table', 'Rattan Headboard', 'Teak Wardrobe', 'Teak Kitchen Cabinet', 'Teak Outdoor Lounger', 'Rattan Sofa Set', 'Teak Gazebo'],
        ['Natural', 'Honey', 'Walnut', 'Whitewash', 'Black', 'Recycled Teak', 'Outdoor Oil', 'Rustic', 'Polished', 'Small', 'Large', 'Custom Size', 'Set of 2'],
    ]]],
];

// What a generated variable product varies by. Its name already says its
// colour, motif or scent, so it varies by size, by age or by grind instead.
$variation_sets = [
    'PAN' => null,
    'COF' => [['Grind', ['Whole Beans', 'Coarse Ground', 'Filter Ground', 'Espresso Ground']]],
    'BOD' => [['Size', ['30 ml', '50 ml', '100 ml', '250 ml'], [0.7, 1, 1.8, 4]]],
    'ACC' => [['Size', ['Small', 'Medium', 'Large', 'Extra Large'], [1, 1.3, 1.6, 2]]],
    'CLO' => [['Size', ['XS', 'S', 'M', 'L', 'XL']]],
    'BAG' => [['Size', ['Small', 'Medium', 'Large', 'Extra Large'], [1, 1.3, 1.6, 2]]],
    'DEC' => [['Size', ['Small', 'Medium', 'Large', 'Extra Large'], [1, 1.3, 1.6, 2]]],
    'FUR' => null,
];
$kids_sizes = [['Size', ['2-3 years', '4-5 years', '6-7 years', '8-9 years']]];

// Typical weights in kilograms by category, for the products that give one.
$weights = ['PAN' => 0.25, 'COF' => 0.3, 'BOD' => 0.2, 'ACC' => 0.15, 'CLO' => 0.3, 'BAG' => 0.6, 'DEC' => 2.5, 'FUR' => 35];

// Prices move away from the realistic product a name is based on by these
// factors, in turn.
$price_factors = [1, 1.15, 1.3, 0.85, 1.6, 0.7, 2.0, 1.1, 0.9, 1.45, 0.8, 1.25];

// The census measured, of all products listed: 74% simple with variable
// products carrying a median of four or five variations, 6% out of stock, 13%
// on sale at a median of 42% off, 4% sold one at a time, weight or dimensions
// on 51% (the first sample's figure; the combined one was not reported); and
// stock counted for 30% of the simple products in stock. Unpriced made-to-order products keep the realistic profile's share,
// four in 113. The realistic profile's 113 products give no weight, so the
// generated ones carry it a little more often to bring the shop to 51%.
$generated_total = HARD_PRODUCTS - 113 - 2;
$weight_share = (0.51 * HARD_PRODUCTS) / $generated_total;

$terms = [];
$base_prices = [];
foreach ($categories as $prefix => [$slug]) {
    $term = get_term_by('slug', $slug, 'product_cat');
    if (!$term) {
        throw new RuntimeException('The realistic profile has no category ' . $slug);
    }
    $terms[$prefix] = $term;
    global $wpdb;
    $base_prices[$prefix] = array_map('intval', $wpdb->get_col($wpdb->prepare(
        "SELECT m.meta_value FROM {$wpdb->postmeta} m JOIN {$wpdb->postmeta} s ON s.post_id = m.post_id AND s.meta_key = '_sku'
         WHERE m.meta_key = '_regular_price' AND m.meta_value <> '' AND s.meta_value LIKE %s ORDER BY s.meta_value",
        $prefix . '-%'
    )));
}

// The generated products divide among the categories as the realistic
// profile's 113 do, the remainders going to the largest fractions.
$shares = [];
foreach ($categories as $prefix => $category) {
    $shares[$prefix] = $generated_total * $category[2] / 113;
}
$counts = array_map('floor', $shares);
$fractions = array_map(static fn ($share, $count) => $share - $count, $shares, $counts);
$fractions = array_combine(array_keys($shares), $fractions);
arsort($fractions);
foreach (array_slice(array_keys($fractions), 0, $generated_total - (int) array_sum($counts)) as $prefix) {
    $counts[$prefix]++;
}

wp_defer_term_counting(true);
$made = ['simple' => 0, 'variable' => 0, 'variations' => 0, 'unpriced' => 0, 'out_of_stock' => 0, 'on_sale' => 0, 'sold_individually' => 0, 'managed_stock' => 0, 'weight' => 0];
$position = 0;
$discounts = [33, 40, 50];
foreach ($categories as $prefix => [$slug, $variable_count, $realistic_count, $groups]) {
    $joiner = $categories[$prefix][4] ?? ', ';
    $names = [];
    foreach ($groups as [$nouns, $qualifiers]) {
        foreach ($qualifiers as $qualifier) {
            foreach ($nouns as $noun_index => $noun) {
                $names[] = [$noun . $joiner . $qualifier, $noun_index, $noun];
            }
        }
    }
    if (count($names) < $counts[$prefix]) {
        throw new RuntimeException('Too few names for ' . $prefix);
    }
    $variable_share = $variable_count / $realistic_count;
    $term = $terms[$prefix];
    // The generated products share the short description the realistic
    // profile gives every product of their category.
    $short = get_post_field('post_excerpt', wc_get_product_id_by_sku($prefix . '-01'));

    for ($index = 0; $index < $counts[$prefix]; $index++, $position++) {
        [$name, $noun_index, $noun] = $names[$index];
        $prices = $base_prices[$prefix];
        $price = hard_round_rupiah($prices[$noun_index % count($prices)] * $price_factors[$index % count($price_factors)]);
        $unpriced = $prefix === 'FUR' && $index % 4 === 3;
        if ($unpriced) {
            $name = 'Made-to-Order ' . $name;
        }
        $set = null;
        if (!$unpriced && $variation_sets[$prefix] && hard_every($index, $variable_share, 0.5)) {
            $set = str_starts_with($noun, 'Kids') ? $kids_sizes : $variation_sets[$prefix];
        }
        $out_of_stock = hard_every($position, 0.06, 0.3);

        $product = $set ? new WC_Product_Variable() : new WC_Product_Simple();
        $product->set_name($name);
        $product->set_slug(sanitize_title($name));
        $product->set_status('publish');
        $product->set_catalog_visibility('visible');
        $product->set_sku(sprintf('%s-H%04d', $prefix, $index + 1));
        $product->set_short_description($short);
        $product->set_description('<p>' . esc_html($name) . '. ' . esc_html($short) . '</p>');
        $product->set_category_ids([(int) $term->term_id]);
        if (hard_every($position, 0.04, 0.7)) {
            $product->set_sold_individually(true);
            $made['sold_individually']++;
        }
        if (hard_every($position, $weight_share, 0.1)) {
            $product->set_weight((string) round($weights[$prefix] * $price_factors[$index % count($price_factors)], 2));
            $made['weight']++;
        }

        if (!$set) {
            if (!$unpriced) {
                $product->set_regular_price((string) $price);
                if (!$out_of_stock && hard_every($position, HARD_ON_SALE_SHARE, 0.9)) {
                    $discount = $discounts[$made['on_sale'] % count($discounts)];
                    $product->set_sale_price((string) hard_round_rupiah($price * (100 - $discount) / 100));
                    $made['on_sale']++;
                }
            } else {
                $made['unpriced']++;
            }
            if ($out_of_stock) {
                $product->set_stock_status('outofstock');
                $made['out_of_stock']++;
            } elseif (!$unpriced && hard_every($made['simple'], 0.30, 0.2)) {
                $product->set_manage_stock(true);
                $product->set_stock_quantity(1 + ($position * 37) % 250);
                $made['managed_stock']++;
            } else {
                $product->set_stock_status('instock');
            }
            $product->save();
            $made['simple']++;
            continue;
        }

        $attributes = [];
        foreach ($set as [$label, $options]) {
            $attribute = new WC_Product_Attribute();
            $attribute->set_id(0);
            $attribute->set_name($label);
            $attribute->set_options($options);
            $attribute->set_visible(true);
            $attribute->set_variation(true);
            $attributes[] = $attribute;
        }
        $product->set_attributes($attributes);
        $product->save();
        $made['variable']++;
        if ($out_of_stock) {
            $made['out_of_stock']++;
        }
        [$label, $options] = $set[0];
        $factors = $set[0][2] ?? array_fill(0, count($options), 1);
        foreach ($options as $option_index => $option) {
            $variation = new WC_Product_Variation();
            $variation->set_parent_id($product->get_id());
            $variation->set_attributes([sanitize_title($label) => $option]);
            $variation->set_regular_price((string) hard_round_rupiah($price * $factors[$option_index]));
            $variation->set_stock_status($out_of_stock ? 'outofstock' : 'instock');
            $variation->save();
            $made['variations']++;
        }
        WC_Product_Variable::sync($product->get_id());
    }
}

// The lab's two downloads, at the baseline's dollar prices taken at the lab's
// round rate. Their files are the baseline's, still in WooCommerce's protected
// uploads.
$downloads_term = wp_insert_term('Guides and Templates', 'product_cat', ['slug' => 'guides-and-templates']);
if (is_wp_error($downloads_term)) {
    throw new RuntimeException($downloads_term->get_error_message());
}
$upload = wp_upload_dir();
foreach ([
    ['DL-GIFT-MESSAGES', 'Gift Message Templates', 1 * HARD_RUPIAH_PER_DOLLAR, 'gift-message-templates.txt'],
    ['DL-WRAPPING-GUIDE', 'Gift Wrapping Guide', 2 * HARD_RUPIAH_PER_DOLLAR, 'gift-wrapping-guide.txt'],
] as [$sku, $name, $price, $file]) {
    if (!is_readable(trailingslashit($upload['basedir']) . 'woocommerce_uploads/' . $file)) {
        throw new RuntimeException('The baseline download is missing: ' . $file);
    }
    $url = trailingslashit($upload['baseurl']) . 'woocommerce_uploads/' . $file;
    $download = new WC_Product_Download();
    $download->set_id(md5($url));
    $download->set_name($file);
    $download->set_file($url);
    $product = new WC_Product_Simple();
    $product->set_props([
        'name' => $name,
        'slug' => sanitize_title($name),
        'status' => 'publish',
        'catalog_visibility' => 'visible',
        'sku' => $sku,
        'regular_price' => (string) $price,
        'short_description' => 'Delivered as one plain-text file.',
        'description' => '<p>' . esc_html($name) . '. Delivered as one plain-text file.</p>',
        'category_ids' => [(int) $downloads_term['term_id']],
        'virtual' => true,
        'downloadable' => true,
        'downloads' => [$download],
        'download_limit' => -1,
        'download_expiry' => -1,
        'manage_stock' => false,
        'sold_individually' => false,
        'stock_status' => 'instock',
    ]);
    $product->save();
    $made['simple']++;
}
wp_defer_term_counting(false);

// The lab's parcel zones, as seed/parcel.php keys them, priced in rupiah at
// the lab's round rate and taxed: Bali by its state, the San Francisco
// postcodes by a pattern, and the rest of Indonesia by its country at two
// rates. Every other place falls to WooCommerce's zone for locations not
// covered, which has no rate, so the shop does not ship there.
foreach (WC_Shipping_Zones::get_zones() as $found) {
    (new WC_Shipping_Zone($found['id']))->delete();
}
foreach ([
    ['Bali', 1, [['ID:BA', 'state']], [['Bali courier', 3.00]]],
    ['San Francisco', 2, [['US', 'country'], ['941*', 'postcode']], [['Standard', 7.50]]],
    ['Indonesia', 3, [['ID', 'country']], [['Standard', 5.00], ['Express', 12.00]]],
] as [$zone_name, $order, $locations, $rates]) {
    $zone = new WC_Shipping_Zone();
    $zone->set_zone_name($zone_name);
    $zone->set_zone_order($order);
    foreach ($locations as [$code, $type]) {
        $zone->add_location($code, $type);
    }
    $zone->save();
    foreach ($rates as [$title, $dollars]) {
        $method = WC_Shipping_Zones::get_shipping_method($zone->add_shipping_method('flat_rate'));
        update_option($method->get_instance_option_key(), [
            'title' => $title,
            'tax_status' => 'taxable',
            'cost' => (string) ($dollars * HARD_RUPIAH_PER_DOLLAR),
        ]);
    }
}
update_option('woocommerce_ship_to_countries', '');

lab_set_tax_mode('tax-incl');

printf(
    "Hard profile: %d products listed, %d simple and %d variable (%d variations); %d unpriced, %d out of stock, %d on sale, %d sold one at a time, %d counting stock, %d with a weight among those added.\n",
    lab_listed_products(),
    $made['simple'] + 84,
    $made['variable'] + 29,
    $made['variations'] + 124,
    $made['unpriced'],
    $made['out_of_stock'],
    $made['on_sale'],
    $made['sold_individually'],
    $made['managed_stock'],
    $made['weight']
);
