#!/usr/bin/env python3

import argparse
from collections import namedtuple
import http.client
import json
import socket
import urllib.parse


Response = namedtuple("Response", ["status", "headers", "body"])


class RoutedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, origin_host, *, connect_host, connect_port, timeout, context=None):
        super().__init__(origin_host, port=443, timeout=timeout, context=context)
        self.connect_host = connect_host
        self.connect_port = connect_port

    def connect(self):
        if self._tunnel_host:
            raise RuntimeError("Release probes do not use an HTTP tunnel")
        raw_socket = socket.create_connection(
            (self.connect_host, self.connect_port),
            self.timeout,
            self.source_address,
        )
        self.sock = self._context.wrap_socket(raw_socket, server_hostname=self.host)


def fetch(url, *, connect_host=None, connect_port=None, timeout=30):
    parsed = urllib.parse.urlsplit(url)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
    ):
        raise ValueError("Release probes require a plain HTTPS origin URL")
    if parsed.port not in (None, 443):
        raise ValueError("Release probe origins must use the public HTTPS port")

    connection = RoutedHTTPSConnection(
        parsed.hostname,
        connect_host=connect_host or parsed.hostname,
        connect_port=connect_port or 443,
        timeout=timeout,
    )
    path = urllib.parse.urlunsplit(("", "", parsed.path or "/", parsed.query, ""))
    headers = {
        "Accept": "application/json",
        "Connection": "close",
        "Host": parsed.netloc,
    }
    try:
        connection.request("GET", path, headers=headers)
        response = connection.getresponse()
        body = response.read()
        response_headers = {name.lower(): value for name, value in response.getheaders()}
        return Response(response.status, response_headers, body)
    finally:
        connection.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description="Probe a public HTTPS origin through its local listener")
    parser.add_argument("--url", required=True)
    parser.add_argument("--connect-host", required=True)
    parser.add_argument("--connect-port", required=True, type=int)
    parser.add_argument("--expect", action="append", required=True, type=int)
    parser.add_argument("--body", action="store_true")
    args = parser.parse_args(argv)

    response = fetch(
        args.url,
        connect_host=args.connect_host,
        connect_port=args.connect_port,
    )
    if response.status not in set(args.expect):
        raise SystemExit(f"{args.url} returned HTTP {response.status}, expected {sorted(set(args.expect))}")
    if args.body:
        print(response.body.decode("utf-8"))
    else:
        print(json.dumps({"status": response.status, "url": args.url}, sort_keys=True))


if __name__ == "__main__":
    main()
