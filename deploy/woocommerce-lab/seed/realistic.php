<?php

// The realistic profile: a shop shaped like the Indonesian WooCommerce shops
// counted in the census the lab README describes, laid over a restored
// baseline. It replaces the baseline catalogue and shipping zones, prices the
// shop in the currency given as the one argument (IDR, the default, or USD),
// enables bank transfer so a person can order as a customer, and hands the
// shop's mail to the lab's mail catcher. Running it again rebuilds the same
// shop, in either currency.

if (!defined('ABSPATH')) {
    exit(1);
}

$currency = strtoupper($args[0] ?? 'IDR');
$formats = [
    'IDR' => ['decimals' => 0, 'thousand' => '.', 'decimal' => ','],
    'USD' => ['decimals' => 2, 'thousand' => ',', 'decimal' => '.'],
];
if (!isset($formats[$currency])) {
    throw new RuntimeException('The currency must be IDR or USD, not ' . $currency);
}

// Prices below are in rupiah. A dollar shop takes them at one round rate
// chosen for the lab, not a market rate, so that both currencies keep the
// same catalogue and the dollar prices carry cents.
const RUPIAH_PER_DOLLAR = 16000;

// Lab equipment rather than part of the profile: every message WordPress
// sends goes to the mail catcher on the shop's network instead of out to the
// recipients, so whoever runs a story reads the customer's and the
// administrator's mail there and nothing reaches a real mailbox.
$mu_plugins = WP_CONTENT_DIR . '/mu-plugins';
wp_mkdir_p($mu_plugins);
$mail_catcher = <<<'PHP'
<?php
// Written by the lab's realistic profile: hands all mail to the lab's mail catcher.
add_action('phpmailer_init', static function ($mailer) {
    $mailer->isSMTP();
    $mailer->Host = 'mailpit';
    $mailer->Port = 1025;
    $mailer->SMTPAuth = false;
    $mailer->SMTPAutoTLS = false;
});
PHP;
if (file_put_contents($mu_plugins . '/lab-mail-catcher.php', $mail_catcher) === false) {
    throw new RuntimeException('Could not write the mail catcher hook into ' . $mu_plugins);
}
// What this run sends, such as the notice that a payment method was enabled,
// goes to the catcher too.
require $mu_plugins . '/lab-mail-catcher.php';

update_option('blogname', 'Test Lifestyle Shop');
update_option('blogdescription', 'Pantry, body care, clothing and things for the home');
update_option('woocommerce_default_country', 'ID:BA');
update_option('woocommerce_store_city', 'Denpasar');
update_option('woocommerce_store_postcode', '80111');
delete_option('woocommerce_store_address');
update_option('woocommerce_currency', $currency);
update_option('woocommerce_currency_pos', 'left');
update_option('woocommerce_price_num_decimals', $formats[$currency]['decimals']);
update_option('woocommerce_price_thousand_sep', $formats[$currency]['thousand']);
update_option('woocommerce_price_decimal_sep', $formats[$currency]['decimal']);

// Bank transfer is the offline method a person completes as a customer: the
// order waits on hold for a payment nobody makes, and the shop sends the
// customer and the administrator their usual mail.
update_option('woocommerce_bacs_settings', ['enabled' => 'yes']);

function lab_round_rupiah(float $amount): int
{
    $step = $amount < 100000 ? 500 : ($amount < 1000000 ? 1000 : 50000);
    return max($step, (int) round($amount / $step) * $step);
}

function lab_amount(int $rupiah, string $currency): string
{
    return $currency === 'IDR'
        ? (string) $rupiah
        : number_format($rupiah / RUPIAH_PER_DOLLAR, 2, '.', '');
}

// The baseline's gift cards and downloads, a tote added by the parcel script,
// their categories and every shipping zone give way to the profile's own.
foreach (get_posts(['post_type' => 'product', 'post_status' => 'any', 'numberposts' => -1, 'fields' => 'ids']) as $id) {
    wc_get_product($id)->delete(true);
}
$default_category = (int) get_option('default_product_cat');
foreach (get_terms(['taxonomy' => 'product_cat', 'hide_empty' => false, 'fields' => 'ids']) as $term_id) {
    if ((int) $term_id !== $default_category) {
        wp_delete_term($term_id, 'product_cat');
    }
}
foreach (WC_Shipping_Zones::get_zones() as $found) {
    (new WC_Shipping_Zone($found['id']))->delete();
}

// One zone for the country the shops sell in, so that a customer's checkout
// has a rate to choose. The census did not measure shipping; this is the least
// a physical order needs.
$zone = new WC_Shipping_Zone();
$zone->set_zone_name('Indonesia');
$zone->set_zone_order(1);
$zone->add_location('ID', 'country');
$zone->save();
$method = WC_Shipping_Zones::get_shipping_method($zone->add_shipping_method('flat_rate'));
update_option($method->get_instance_option_key(), [
    'title' => 'Regular courier',
    'tax_status' => 'none',
    'cost' => lab_amount(24000, $currency),
]);

// Each category with the short description its products share and the
// sentence their longer description builds on.
$categories = [
    'pantry' => ['Pantry and Snacks', 'Sauces, spices and snacks for an Indonesian kitchen.', 'A pantry staple, packed for the kitchen cupboard.'],
    'coffee' => ['Coffee and Cacao', 'Coffee, tea and chocolate from Indonesian growers.', 'Roasted or made in small batches and packed airtight.'],
    'body' => ['Body Care', 'Soaps, oils and creams made with plant ingredients.', 'Made in small batches with plant oils and natural scents.'],
    'accessories' => ['Phone and Computer Accessories', 'Cables, holders and audio for phones and laptops.', 'An everyday accessory for a phone or a laptop.'],
    'clothing' => ['Clothing', 'Cotton, linen and rayon clothing for warm weather.', 'Cut for warm weather from light, breathable fabric.'],
    'bags' => ['Bags', 'Woven, leather and canvas bags.', 'A bag made by hand from natural or durable materials.'],
    'decor' => ['Home Decor', 'Lamps, rugs, mirrors and tableware.', 'Made by hand for the home from natural materials.'],
    'furniture' => ['Furniture', 'Teak and rattan furniture, in stock or made to order.', 'Teak or rattan furniture, finished by hand.'],
];

// A variable product's attributes, each with its options and, where an
// option changes the price, the factor applied to the product's base price.
$variation_sets = [
    'size' => [['Size', ['S', 'M', 'L', 'XL']]],
    'kids' => [['Size', ['2-3 years', '4-5 years', '6-7 years', '8-9 years']]],
    'color-size' => [['Color', ['Black', 'Sand', 'Sage']], ['Size', ['S', 'M', 'L', 'XL']]],
    'color2' => [['Color', ['Natural', 'Black']]],
    'color3' => [['Color', ['Natural', 'Black', 'Olive']]],
    'scent2' => [['Scent', ['Frangipani', 'Sandalwood']]],
    'scent4' => [['Scent', ['Lavender', 'Peppermint', 'Lemongrass', 'Eucalyptus']]],
    'weight' => [['Weight', ['250 g', '500 g', '1 kg'], [1, 1.9, 3.6]]],
    'rug' => [['Size', ['120 x 180 cm', '160 x 230 cm', '200 x 300 cm'], [1, 1.6, 2.5]]],
];

// The catalogue, in rupiah. `stock` counts the product's stock at that
// quantity; `out_of_stock`, `sale_percent` and `sold_individually` are what
// they say; a product without `price` has none, as a made-to-order piece
// whose price the shop gives on request.
$catalogue = [
    'pantry' => [
        ['sku' => 'PAN-01', 'name' => 'Chili Sambal Sachet', 'price' => 2000, 'stock' => 200],
        ['sku' => 'PAN-02', 'name' => 'Shrimp Cracker Sachet', 'price' => 2000],
        ['sku' => 'PAN-03', 'name' => 'Instant Ginger Drink Sachet', 'price' => 2000, 'stock' => 250],
        ['sku' => 'PAN-04', 'name' => 'Sweet Soy Sauce Sachet', 'price' => 2000],
        ['sku' => 'PAN-05', 'name' => 'Peanut Sauce Sachet', 'price' => 2000],
        ['sku' => 'PAN-06', 'name' => 'Fried Shallots, 50 g', 'price' => 5500, 'out_of_stock' => true],
        ['sku' => 'PAN-07', 'name' => 'Turmeric Powder, 50 g', 'price' => 12500, 'sale_percent' => 40],
        ['sku' => 'PAN-08', 'name' => 'Coriander Seeds, 100 g', 'price' => 13500],
        ['sku' => 'PAN-09', 'name' => 'Cassava Crackers, 150 g', 'price' => 14500, 'stock' => 45],
        ['sku' => 'PAN-10', 'name' => 'Banana Chips, 150 g', 'price' => 15000],
        ['sku' => 'PAN-11', 'name' => 'Chili Sambal, 200 g Jar', 'price' => 18500, 'stock' => 18],
    ],
    'coffee' => [
        ['sku' => 'COF-01', 'name' => 'Coffee Drip Bags, Pack of 5', 'price' => 20500],
        ['sku' => 'COF-02', 'name' => 'Ginger Lemongrass Tea, 20 Bags', 'price' => 25000, 'stock' => 30],
        ['sku' => 'COF-03', 'name' => 'Milk Chocolate Bar with Coconut', 'price' => 28000],
        ['sku' => 'COF-04', 'name' => 'Dark Chocolate Bar, 70%', 'price' => 31000, 'sale_percent' => 33],
        ['sku' => 'COF-05', 'name' => 'Dark Chocolate Bar, 85%', 'price' => 33500],
        ['sku' => 'COF-06', 'name' => 'Cacao Nibs, 100 g', 'price' => 37500, 'stock' => 12],
        ['sku' => 'COF-07', 'name' => 'Green Tea Leaves, 100 g', 'price' => 40000, 'sale_percent' => 50],
        ['sku' => 'COF-08', 'name' => 'Ground Robusta Coffee, 200 g', 'price' => 44500],
        ['sku' => 'COF-09', 'name' => 'Drinking Chocolate Powder, 250 g', 'price' => 50000, 'stock' => 60],
        ['sku' => 'COF-10', 'name' => 'Cacao Butter, 200 g', 'price' => 55500],
        ['sku' => 'COF-11', 'name' => 'Robusta Coffee Beans', 'price' => 62000, 'variations' => 'weight'],
        ['sku' => 'COF-12', 'name' => 'Arabica Coffee Beans, Medium Roast', 'price' => 70000, 'variations' => 'weight'],
        ['sku' => 'COF-13', 'name' => 'Arabica Coffee Beans, Dark Roast', 'price' => 75000, 'variations' => 'weight'],
        ['sku' => 'COF-14', 'name' => 'Single-Origin Arabica Beans, Light Roast', 'price' => 77000, 'variations' => 'weight'],
    ],
    'body' => [
        ['sku' => 'BOD-01', 'name' => 'Lemongrass Soap Bar', 'price' => 77000, 'stock' => 99],
        ['sku' => 'BOD-02', 'name' => 'Coconut Soap Bar', 'price' => 79000],
        ['sku' => 'BOD-03', 'name' => 'Charcoal Soap Bar', 'price' => 80000, 'sale_percent' => 40],
        ['sku' => 'BOD-04', 'name' => 'Frangipani Soap Bar', 'price' => 80000],
        ['sku' => 'BOD-05', 'name' => 'Vanilla Lip Balm', 'price' => 80000, 'stock' => 25],
        ['sku' => 'BOD-06', 'name' => 'Shampoo Bar', 'price' => 81500],
        ['sku' => 'BOD-07', 'name' => 'Deodorant Cream', 'price' => 85000, 'out_of_stock' => true],
        ['sku' => 'BOD-08', 'name' => 'Coffee Body Scrub', 'price' => 89000, 'sale_percent' => 33],
        ['sku' => 'BOD-09', 'name' => 'Coconut Body Scrub', 'price' => 90000, 'stock' => 8],
        ['sku' => 'BOD-10', 'name' => 'Virgin Coconut Oil, 100 ml', 'price' => 95000],
        ['sku' => 'BOD-11', 'name' => 'Candlenut Hair Oil', 'price' => 99000, 'sale_percent' => 50],
        ['sku' => 'BOD-12', 'name' => 'Insect Repellent Balm', 'price' => 99000, 'sold_individually' => true],
        ['sku' => 'BOD-13', 'name' => 'Rose Face Toner', 'price' => 99000, 'stock' => 5],
        ['sku' => 'BOD-14', 'name' => 'Sandalwood Massage Oil', 'price' => 100000],
        ['sku' => 'BOD-15', 'name' => 'Frangipani Body Lotion', 'price' => 100000, 'stock' => 3],
        ['sku' => 'BOD-16', 'name' => 'Essential Oil, 10 ml', 'price' => 104000, 'variations' => 'scent4'],
        ['sku' => 'BOD-17', 'name' => 'Brightening Face Serum', 'price' => 116000],
        ['sku' => 'BOD-18', 'name' => 'Reed Diffuser, 100 ml', 'price' => 122000, 'variations' => 'scent2'],
    ],
    'accessories' => [
        ['sku' => 'ACC-01', 'name' => 'USB-C Charging Cable, 1 m', 'price' => 130000, 'stock' => 120],
        ['sku' => 'ACC-02', 'name' => 'Lightning Charging Cable, 1 m', 'price' => 137000],
        ['sku' => 'ACC-03', 'name' => 'Wired Earphones', 'price' => 145000, 'sale_percent' => 33],
        ['sku' => 'ACC-04', 'name' => 'Desk Phone Holder', 'price' => 150000],
        ['sku' => 'ACC-05', 'name' => 'Silicone Phone Case', 'price' => 150000, 'variations' => 'color3'],
        ['sku' => 'ACC-06', 'name' => 'Car Phone Holder', 'price' => 154000, 'stock' => 14],
        ['sku' => 'ACC-07', 'name' => 'Wireless Mouse', 'price' => 159000],
        ['sku' => 'ACC-08', 'name' => 'Laptop Cooling Pad', 'price' => 165000, 'out_of_stock' => true],
        ['sku' => 'ACC-09', 'name' => 'Mini Bluetooth Speaker', 'price' => 169000, 'stock' => 4],
        ['sku' => 'ACC-10', 'name' => 'Webcam, 1080p', 'price' => 170000, 'sold_individually' => true],
        ['sku' => 'ACC-11', 'name' => 'Power Bank, 10,000 mAh', 'price' => 175000, 'sale_percent' => 40],
        ['sku' => 'ACC-12', 'name' => 'Wireless Earbuds', 'price' => 177000, 'stock' => 2],
    ],
    'clothing' => [
        ['sku' => 'CLO-01', 'name' => 'Cotton T-Shirt', 'price' => 180000, 'variations' => 'size'],
        ['sku' => 'CLO-02', 'name' => 'Kids\' Cotton T-Shirt', 'price' => 189000, 'variations' => 'kids'],
        ['sku' => 'CLO-03', 'name' => 'Tank Top', 'price' => 199000, 'variations' => 'size'],
        ['sku' => 'CLO-04', 'name' => 'Batik Scarf', 'price' => 202000, 'stock' => 11],
        ['sku' => 'CLO-05', 'name' => 'Long Sleeve Tee', 'price' => 220000, 'variations' => 'size'],
        ['sku' => 'CLO-06', 'name' => 'Bucket Hat', 'price' => 230000, 'sale_percent' => 50],
        ['sku' => 'CLO-07', 'name' => 'Rayon Sarong', 'price' => 240000],
        ['sku' => 'CLO-08', 'name' => 'Linen Shorts', 'price' => 250000, 'variations' => 'size'],
        ['sku' => 'CLO-09', 'name' => 'Board Shorts', 'price' => 250000, 'variations' => 'size'],
        ['sku' => 'CLO-10', 'name' => 'Woven Belt', 'price' => 268000],
        ['sku' => 'CLO-11', 'name' => 'Wrap Skirt', 'price' => 276000, 'variations' => 'color-size'],
        ['sku' => 'CLO-12', 'name' => 'Batik Cotton Shirt', 'price' => 285000, 'variations' => 'size'],
        ['sku' => 'CLO-13', 'name' => 'Rayon Beach Dress', 'price' => 295000, 'variations' => 'color-size'],
        ['sku' => 'CLO-14', 'name' => 'Linen Shirt', 'price' => 301000, 'variations' => 'color-size'],
        ['sku' => 'CLO-15', 'name' => 'Knit Cardigan', 'price' => 330000, 'variations' => 'size', 'out_of_stock' => true],
        ['sku' => 'CLO-16', 'name' => 'Hooded Sweatshirt', 'price' => 346000, 'variations' => 'size'],
        ['sku' => 'CLO-17', 'name' => 'Linen Trousers', 'price' => 350000, 'variations' => 'size'],
        ['sku' => 'CLO-18', 'name' => 'Kaftan', 'price' => 372000, 'variations' => 'size'],
        ['sku' => 'CLO-19', 'name' => 'Jumpsuit', 'price' => 383000, 'variations' => 'size'],
        ['sku' => 'CLO-20', 'name' => 'Linen Blazer', 'price' => 396000, 'variations' => 'size'],
    ],
    'bags' => [
        ['sku' => 'BAG-01', 'name' => 'Batik Pouch', 'price' => 400000, 'stock' => 20],
        ['sku' => 'BAG-02', 'name' => 'Leather Wallet', 'price' => 409000],
        ['sku' => 'BAG-03', 'name' => 'Laptop Sleeve', 'price' => 429000, 'sale_percent' => 33],
        ['sku' => 'BAG-04', 'name' => 'Water Hyacinth Clutch', 'price' => 450000, 'out_of_stock' => true],
        ['sku' => 'BAG-05', 'name' => 'Crochet Shoulder Bag', 'price' => 465000, 'variations' => 'color2'],
        ['sku' => 'BAG-06', 'name' => 'Straw Beach Bag', 'price' => 481000],
        ['sku' => 'BAG-07', 'name' => 'Woven Tote Bag', 'price' => 500000, 'variations' => 'color3'],
        ['sku' => 'BAG-08', 'name' => 'Seagrass Basket Bag', 'price' => 520000, 'sale_percent' => 40],
        ['sku' => 'BAG-09', 'name' => 'Macrame Bag', 'price' => 579000, 'variations' => 'color2', 'out_of_stock' => true],
        ['sku' => 'BAG-10', 'name' => 'Canvas Backpack', 'price' => 649000, 'variations' => 'color3'],
        ['sku' => 'BAG-11', 'name' => 'Rattan Round Bag', 'price' => 704000, 'stock' => 16],
        ['sku' => 'BAG-12', 'name' => 'Leather Crossbody Bag', 'price' => 808000, 'variations' => 'color2'],
    ],
    'decor' => [
        ['sku' => 'DEC-01', 'name' => 'Rattan Pendant Lamp', 'price' => 867000, 'stock' => 3],
        ['sku' => 'DEC-02', 'name' => 'Jute Floor Rug', 'price' => 955000, 'variations' => 'rug'],
        ['sku' => 'DEC-03', 'name' => 'Stoneware Dinner Set for Six', 'price' => 1000000, 'sale_percent' => 50],
        ['sku' => 'DEC-04', 'name' => 'Large Macrame Wall Hanging', 'price' => 1050000],
        ['sku' => 'DEC-05', 'name' => 'Ceramic Floor Vase', 'price' => 1200000, 'out_of_stock' => true],
        ['sku' => 'DEC-06', 'name' => 'Teak Wall Mirror', 'price' => 1500000, 'sold_individually' => true],
        ['sku' => 'DEC-07', 'name' => 'Brass Table Lamp', 'price' => 1500000],
        ['sku' => 'DEC-08', 'name' => 'Cotton Hammock', 'price' => 1900000, 'stock' => 24],
        ['sku' => 'DEC-09', 'name' => 'Rattan Floor Lamp', 'price' => 2600000, 'sale_percent' => 33],
        ['sku' => 'DEC-10', 'name' => 'Carved Teak Wall Panel', 'price' => 4350000],
    ],
    'furniture' => [
        ['sku' => 'FUR-01', 'name' => 'Teak Side Table', 'price' => 7350000],
        ['sku' => 'FUR-02', 'name' => 'Rattan Armchair', 'price' => 9650000, 'stock' => 2],
        ['sku' => 'FUR-03', 'name' => 'Teak Bench', 'price' => 9650000, 'sale_percent' => 40],
        ['sku' => 'FUR-04', 'name' => 'Teak Bookshelf', 'price' => 10500000, 'sold_individually' => true],
        ['sku' => 'FUR-05', 'name' => 'Rattan Lounge Chair', 'price' => 10500000],
        ['sku' => 'FUR-06', 'name' => 'Teak Coffee Table', 'price' => 10500000, 'stock' => 6],
        ['sku' => 'FUR-07', 'name' => 'Teak Sideboard', 'price' => 11050000],
        ['sku' => 'FUR-08', 'name' => 'Rattan Sofa, Two Seats', 'price' => 14050000, 'sale_percent' => 33],
        ['sku' => 'FUR-09', 'name' => 'Teak Daybed', 'price' => 19650000, 'sold_individually' => true],
        ['sku' => 'FUR-10', 'name' => 'Teak Bed Frame, Queen', 'price' => 27200000, 'stock' => 1],
        ['sku' => 'FUR-11', 'name' => 'Teak Dining Table for Six', 'price' => 33850000],
        ['sku' => 'FUR-12', 'name' => 'Teak Dining Table for Ten', 'price' => 40500000],
        ['sku' => 'FUR-13', 'name' => 'Made-to-Order Teak Wardrobe'],
        ['sku' => 'FUR-14', 'name' => 'Made-to-Order Teak Kitchen Cabinet'],
        ['sku' => 'FUR-15', 'name' => 'Made-to-Order Rattan Sofa Set'],
        ['sku' => 'FUR-16', 'name' => 'Made-to-Order Teak Gazebo'],
    ],
];

$counts = ['simple' => 0, 'variable' => 0, 'variations' => 0];
foreach ($catalogue as $key => $items) {
    [$category_name, $short, $sentence] = $categories[$key];
    $term = wp_insert_term($category_name, 'product_cat', ['slug' => sanitize_title($category_name)]);
    if (is_wp_error($term)) {
        throw new RuntimeException($term->get_error_message());
    }
    foreach ($items as $item) {
        $set = isset($item['variations']) ? $variation_sets[$item['variations']] : null;
        $product = $set ? new WC_Product_Variable() : new WC_Product_Simple();
        $product->set_name($item['name']);
        $product->set_slug(sanitize_title($item['name']));
        $product->set_status('publish');
        $product->set_catalog_visibility('visible');
        $product->set_sku($item['sku']);
        $product->set_short_description($short);
        $product->set_description('<p>' . esc_html($item['name']) . '. ' . $sentence . '</p>');
        $product->set_category_ids([(int) $term['term_id']]);
        $product->set_sold_individually(!empty($item['sold_individually']));
        $stock_status = empty($item['out_of_stock']) ? 'instock' : 'outofstock';

        if (!$set) {
            if (isset($item['price'])) {
                $product->set_regular_price(lab_amount($item['price'], $currency));
                if (isset($item['sale_percent'])) {
                    $sale = lab_round_rupiah($item['price'] * (100 - $item['sale_percent']) / 100);
                    $product->set_sale_price(lab_amount($sale, $currency));
                }
            }
            if (isset($item['stock'])) {
                $product->set_manage_stock(true);
                $product->set_stock_quantity($item['stock']);
            } else {
                $product->set_stock_status($stock_status);
            }
            $product->save();
            $counts['simple']++;
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
        $counts['variable']++;

        $combinations = [[[], 1.0]];
        foreach ($set as $attribute) {
            [$label, $options] = $attribute;
            $factors = $attribute[2] ?? array_fill(0, count($options), 1);
            $next = [];
            foreach ($combinations as [$chosen, $factor]) {
                foreach ($options as $index => $option) {
                    $next[] = [$chosen + [sanitize_title($label) => $option], $factor * $factors[$index]];
                }
            }
            $combinations = $next;
        }
        foreach ($combinations as [$chosen, $factor]) {
            $variation = new WC_Product_Variation();
            $variation->set_parent_id($product->get_id());
            $variation->set_attributes($chosen);
            $variation->set_regular_price(lab_amount(lab_round_rupiah($item['price'] * $factor), $currency));
            $variation->set_stock_status($stock_status);
            $variation->save();
            $counts['variations']++;
        }
        WC_Product_Variable::sync($product->get_id());
    }
}

printf(
    "Realistic profile in %s: %d simple and %d variable products (%d variations).\n",
    $currency,
    $counts['simple'],
    $counts['variable'],
    $counts['variations']
);
