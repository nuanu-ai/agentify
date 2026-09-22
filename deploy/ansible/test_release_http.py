import importlib.util
from pathlib import Path
import unittest
from unittest import mock


SCRIPT = Path(__file__).with_name("release_http.py")
SPEC = importlib.util.spec_from_file_location("agentify_release_http", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Cannot load the release HTTP client under test")
HTTP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HTTP)


class ReleaseHttpTest(unittest.TestCase):
    def test_direct_connection_preserves_public_tls_name(self):
        raw_socket = object()
        wrapped_socket = object()
        context = mock.Mock()
        context.wrap_socket.return_value = wrapped_socket

        with mock.patch.object(HTTP.socket, "create_connection", return_value=raw_socket) as create:
            connection = HTTP.RoutedHTTPSConnection(
                "test.agentify.ad",
                connect_host="192.0.2.10",
                connect_port=8443,
                timeout=7,
                context=context,
            )
            connection.connect()

        create.assert_called_once_with(("192.0.2.10", 8443), 7, None)
        context.wrap_socket.assert_called_once_with(raw_socket, server_hostname="test.agentify.ad")
        self.assertIs(connection.sock, wrapped_socket)

    def test_fetch_uses_public_host_and_private_connection_target(self):
        response = mock.Mock(status=200)
        response.read.return_value = b'{"items":[]}'
        response.getheaders.return_value = [("Content-Type", "application/json")]
        connection = mock.MagicMock()
        connection.getresponse.return_value = response

        with mock.patch.object(HTTP, "RoutedHTTPSConnection", return_value=connection) as connection_type:
            actual = HTTP.fetch(
                "https://test.agentify.ad/x402/catalog?visible=true",
                connect_host="192.0.2.10",
                connect_port=8443,
                timeout=9,
            )

        connection_type.assert_called_once_with(
            "test.agentify.ad",
            connect_host="192.0.2.10",
            connect_port=8443,
            timeout=9,
        )
        connection.request.assert_called_once_with(
            "GET",
            "/x402/catalog?visible=true",
            headers={"Accept": "application/json", "Connection": "close", "Host": "test.agentify.ad"},
        )
        self.assertEqual(actual.status, 200)
        self.assertEqual(actual.body, b'{"items":[]}')
        self.assertEqual(actual.headers["content-type"], "application/json")
        connection.close.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
