<?php
// One read/write REST key for the administrator, made the way WooCommerce's
// own key screen makes it. Prints "consumer_key consumer_secret".
global $wpdb;
$key = 'ck_' . wc_rand_hash();
$secret = 'cs_' . wc_rand_hash();
$wpdb->insert($wpdb->prefix . 'woocommerce_api_keys', [
    'user_id' => 1,
    'description' => 'tax probe',
    'permissions' => 'read_write',
    'consumer_key' => wc_api_hash($key),
    'consumer_secret' => $secret,
    'truncated_key' => substr($key, -7),
]);
echo $key . ' ' . $secret;
