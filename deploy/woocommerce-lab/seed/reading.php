<?php

// One reading of the settings a WooCommerce shop runs on, printed as JSON:
//
//   wp eval-file /seed/reading.php
//
// Every WooCommerce option, the WordPress settings a shop depends on, its
// plugins, payment methods, shipping zones, taxes, webhooks and REST API keys.
// A secret is never printed. A REST API key is named by its description,
// permissions and last access alone. Any other value under a name that marks
// it as a secret, such as a payment plugin's secret key, is printed as a keyed
// hash, so that two readings show whether it changed without showing it; the
// key is this WordPress installation's own salt, which no reading contains.

if (!defined('ABSPATH')) {
    exit(1);
}
require_once ABSPATH . 'wp-admin/includes/plugin.php';

const LAB_SECRET_NAME = '/secret|password|passwd|pwd|token|api_?key|private_?key|signature|webhook_?key|consumer_?key|nonce|salt/i';

function lab_redact($value, string $name, bool $secret = false)
{
    $secret = $secret || preg_match(LAB_SECRET_NAME, $name);
    if (is_array($value) || is_object($value)) {
        $out = [];
        foreach ((array) $value as $key => $inner) {
            $out[$key] = lab_redact($inner, (string) $key, $secret);
        }
        return $out;
    }
    if ($secret && $value !== null && (string) $value !== '') {
        return 'secret, keyed hash ' . substr(hash_hmac('sha256', (string) $value, wp_salt('auth')), 0, 12);
    }
    return $value;
}

global $wpdb;
$reading = ['taken_at' => gmdate('Y-m-d\TH:i:s\Z')];

$wordpress = [
    'version' => get_bloginfo('version'),
    'site address (effective)' => site_url(),
    'home address (effective)' => home_url(),
];
foreach ([
    'siteurl', 'home', 'blogname', 'blogdescription', 'admin_email', 'permalink_structure', 'category_base',
    'tag_base', 'timezone_string', 'gmt_offset', 'date_format', 'time_format', 'start_of_week', 'WPLANG',
    'users_can_register', 'default_role', 'blog_public', 'show_on_front', 'page_on_front', 'page_for_posts',
    'template', 'stylesheet', 'uploads_use_yearmonth_folders',
] as $option) {
    $wordpress[$option] = get_option($option);
}
$theme = wp_get_theme();
$wordpress['theme'] = $theme->get_stylesheet() . ' ' . $theme->get('Version');
$reading['WordPress'] = $wordpress;

$reading['mail'] = [
    'administrator address' => get_option('admin_email'),
    'WooCommerce sender name' => get_option('woocommerce_email_from_name'),
    'WooCommerce sender address' => get_option('woocommerce_email_from_address'),
    'hooks that redirect outgoing mail (phpmailer_init)' => has_action('phpmailer_init') ? 'yes' : 'no',
];

$plugins = [];
foreach (get_plugins() as $file => $data) {
    $plugins[dirname($file) === '.' ? $file : dirname($file)] = $data['Version'] . (is_plugin_active($file) ? ', active' : ', inactive');
}
$reading['plugins'] = $plugins;
$reading['must-use plugins'] = array_map(static fn ($data) => $data['Version'] ?: 'no version', get_mu_plugins());

$reading['payment methods'] = [];
foreach (WC()->payment_gateways()->payment_gateways() as $gateway) {
    $reading['payment methods'][$gateway->id] = $gateway->get_title() . ($gateway->enabled === 'yes' ? ', enabled' : ', disabled');
}

$zones = [];
foreach (array_merge([0], array_column(WC_Shipping_Zones::get_zones(), 'id')) as $id) {
    $zone = new WC_Shipping_Zone($id);
    $methods = [];
    foreach ($zone->get_shipping_methods() as $method) {
        $methods[$method->id . ' ' . $method->get_instance_id()] = lab_redact($method->instance_settings, 'settings')
            + ['enabled' => $method->is_enabled() ? 'yes' : 'no'];
    }
    $zones[$id ? $zone->get_zone_name() : 'Locations not covered by other zones'] = [
        'order' => $zone->get_zone_order(),
        'locations' => array_map(static fn ($location) => $location->type . ' ' . $location->code, $zone->get_zone_locations()),
        'methods' => $methods,
    ];
}
$reading['shipping zones'] = $zones;

$rates = [];
foreach ($wpdb->get_results("SELECT * FROM {$wpdb->prefix}woocommerce_tax_rates ORDER BY tax_rate_class, tax_rate_order, tax_rate_id", ARRAY_A) as $rate) {
    $places = $wpdb->get_col($wpdb->prepare(
        "SELECT CONCAT(location_type, ' ', location_code) FROM {$wpdb->prefix}woocommerce_tax_rate_locations WHERE tax_rate_id = %d ORDER BY location_type, location_code",
        $rate['tax_rate_id']
    ));
    // Named by what the rate is rather than by its number, which changes
    // whenever rates are entered again.
    $label = sprintf('%s %s, %s, %s', $rate['tax_rate_country'] ?: 'any country', $rate['tax_rate_state'] ?: 'any state', $rate['tax_rate_name'], $rate['tax_rate_class'] ?: 'standard');
    for ($same = 2; isset($rates[$label]); $same++) {
        $label = preg_replace('/ #\d+$/', '', $label) . ' #' . $same;
    }
    $rates[$label] = [
        'class' => $rate['tax_rate_class'] ?: 'standard',
        'country' => $rate['tax_rate_country'] ?: 'any',
        'state' => $rate['tax_rate_state'] ?: 'any',
        'postcodes and cities' => $places,
        'rate' => $rate['tax_rate'],
        'name' => $rate['tax_rate_name'],
        'priority' => $rate['tax_rate_priority'],
        'compound' => $rate['tax_rate_compound'] ? 'yes' : 'no',
        'applies to shipping' => $rate['tax_rate_shipping'] ? 'yes' : 'no',
    ];
}
$reading['tax'] = ['classes' => WC_Tax::get_tax_classes(), 'rates' => $rates];

// By description, permissions and last access only: the table also holds the
// secret itself in the clear, and a hash and the last characters of the key.
$keys = [];
foreach ($wpdb->get_results(
    "SELECT k.key_id, k.description, k.permissions, k.last_access, u.user_login
     FROM {$wpdb->prefix}woocommerce_api_keys k LEFT JOIN {$wpdb->users} u ON u.ID = k.user_id ORDER BY k.key_id",
    ARRAY_A
) as $key) {
    $keys['key ' . $key['key_id']] = [
        'description' => $key['description'],
        'user' => $key['user_login'],
        'permissions' => $key['permissions'],
        'last access' => $key['last_access'] ?: 'never',
    ];
}
$reading['REST API keys'] = $keys;

$webhooks = [];
foreach ($wpdb->get_results("SELECT webhook_id, name, status, topic, delivery_url FROM {$wpdb->prefix}wc_webhooks ORDER BY webhook_id", ARRAY_A) as $hook) {
    $url = wp_parse_url($hook['delivery_url']);
    $webhooks['webhook ' . $hook['webhook_id']] = [
        'name' => $hook['name'],
        'status' => $hook['status'],
        'topic' => $hook['topic'],
        'delivers to' => ($url['host'] ?? '') . ($url['path'] ?? ''),
    ];
}
$reading['webhooks'] = $webhooks;

// Every option WooCommerce and its extensions keep under its prefixes, with
// transients and caches left out because they change on their own.
$options = [];
foreach ($wpdb->get_results(
    "SELECT option_name, option_value FROM {$wpdb->options}
     WHERE (option_name LIKE 'woocommerce\\_%' OR option_name LIKE 'wc\\_%') ORDER BY option_name",
    ARRAY_A
) as $row) {
    $options[$row['option_name']] = lab_redact(maybe_unserialize($row['option_value']), $row['option_name']);
}
$reading['WooCommerce options'] = $options;

echo wp_json_encode($reading, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR) . "\n";
