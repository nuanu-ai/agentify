<?php
/**
 * Plugin Name: Coinslot probe instrument
 * Description: Records what the shop does on the way out — outbound HTTP, mail
 *              attempts — so the probes can cite evidence instead of guessing.
 *
 * This is the only file in the stand that is not a stock WooCommerce install.
 * Two of the three hooks below only observe. The third changes behaviour, and
 * it is gated behind a flag file so a probe can measure the difference:
 *
 *   /var/probe/allow-private-callback    Two things stand between this shop
 *     and the callback receiver next to it, and both exist only because the
 *     whole stand is on one laptop:
 *       - wp_safe_remote_post() refuses a URL that resolves to a private
 *         address, and the receiver is on the compose network at 172.x;
 *       - the receiver's certificate is self-signed, and WordPress verifies
 *         outbound TLS against its own bundled CA list.
 *     A real merchant shop calls our public https endpoint with a real
 *     certificate and meets neither. probe.sh runs the grant once without this
 *     flag to record what a stock shop does, then once with it.
 *     Note that verification is not switched off under the flag — it is
 *     pointed at the stand's own certificate, so a wrong certificate still
 *     fails.
 *
 * Nothing here is meant to ship. It is a measuring instrument for a spike.
 */

defined( 'ABSPATH' ) || exit;

const COINSLOT_PROBE_DIR = '/var/probe';

function coinslot_probe_append( $file, array $record ) {
	$record['at'] = gmdate( 'c' );
	$line         = wp_json_encode( $record, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );
	@file_put_contents( COINSLOT_PROBE_DIR . '/' . $file, $line . "\n", FILE_APPEND | LOCK_EX );
}

/**
 * Every outbound request the shop makes, with its outcome. This is how we see
 * the wc-auth callback POST leave (or fail to leave) the shop.
 */
add_action(
	'http_api_debug',
	function ( $response, $context, $transport, $parsed_args, $url ) {
		$outcome = is_wp_error( $response )
			? array(
				'error_code'    => $response->get_error_code(),
				'error_message' => $response->get_error_message(),
			)
			: array( 'status' => wp_remote_retrieve_response_code( $response ) );

		coinslot_probe_append(
			'http.jsonl',
			array_merge(
				array(
					'url'       => $url,
					'method'    => $parsed_args['method'] ?? 'GET',
					'transport' => $transport,
					'context'   => $context,
				),
				$outcome
			)
		);
	},
	10,
	5
);

/**
 * Mail. We record the attempt and let it proceed: the container has no MTA, so
 * the failure that follows is itself the observation the probe reports. The
 * three hooks separate "the shop tried", "the shop believes it sent" and "the
 * shop knows it failed".
 */
add_filter(
	'pre_wp_mail',
	function ( $short_circuit, $atts ) {
		coinslot_probe_append(
			'mail.jsonl',
			array(
				'event'   => 'attempted',
				'to'      => $atts['to'] ?? null,
				'subject' => $atts['subject'] ?? null,
			)
		);
		return $short_circuit;
	},
	10,
	2
);

add_action(
	'wp_mail_succeeded',
	function ( $mail_data ) {
		coinslot_probe_append(
			'mail.jsonl',
			array(
				'event'   => 'succeeded',
				'to'      => $mail_data['to'] ?? null,
				'subject' => $mail_data['subject'] ?? null,
			)
		);
	}
);

add_action(
	'wp_mail_failed',
	function ( $error ) {
		$data = $error instanceof WP_Error ? $error->get_error_data() : array();
		coinslot_probe_append(
			'mail.jsonl',
			array(
				'event'   => 'failed',
				'to'      => $data['to'] ?? null,
				'subject' => $data['subject'] ?? null,
				'reason'  => $error instanceof WP_Error ? $error->get_error_message() : 'unknown',
			)
		);
	}
);

/**
 * The behaviour changes, and only while the flag file is present. Both are
 * scoped to the single host `callback`: nothing else in the shop is affected.
 */
function coinslot_probe_local_callback_allowed() {
	$path = COINSLOT_PROBE_DIR . '/allow-private-callback';
	// Without this, PHP's realpath cache can answer from up to realpath_cache_ttl
	// seconds ago (120 by default), and the probe's first, deliberately
	// unassisted attempt would silently inherit the previous run's allowance —
	// a green that measures nothing.
	clearstatcache( true, $path );
	return file_exists( $path );
}

add_filter(
	'http_request_host_is_external',
	function ( $is_external, $host, $url ) {
		if ( 'callback' !== $host || ! coinslot_probe_local_callback_allowed() ) {
			return $is_external;
		}
		coinslot_probe_append(
			'http.jsonl',
			array(
				'url'  => $url,
				'host' => $host,
				'note' => 'private host allowed by the probe instrument (local stand only)',
			)
		);
		return true;
	},
	10,
	3
);

add_filter(
	'http_request_args',
	function ( $args, $url ) {
		$host = wp_parse_url( $url, PHP_URL_HOST );
		if ( 'callback' !== $host || ! coinslot_probe_local_callback_allowed() ) {
			return $args;
		}
		$cert = '/var/certs/callback-cert.pem';
		if ( ! file_exists( $cert ) ) {
			return $args;
		}
		// Still verifying, just against the stand's own certificate instead of
		// the bundled public CA list.
		$args['sslverify']       = true;
		$args['sslcertificates'] = $cert;
		coinslot_probe_append(
			'http.jsonl',
			array(
				'url'  => $url,
				'host' => $host,
				'note' => 'outbound TLS pinned to the stand certificate (local stand only)',
			)
		);
		return $args;
	},
	10,
	2
);
