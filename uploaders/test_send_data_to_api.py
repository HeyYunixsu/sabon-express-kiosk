"""Error-path check for send_data_to_api().

The bug this guards against: requests.post() raises before `response` is
assigned, so the except block's `if response is not None` threw
UnboundLocalError -- the function raised instead of returning None, and the
uploader lost the server's error body. Seen live on 2026-09-11 when the API
port stopped answering.

Run:  python uploaders/test_send_data_to_api.py
"""
import socket
import transaction_uploader as tu


def _closed_port():
    """A port nothing is listening on, so connecting is refused immediately."""
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def test_refused_connection_returns_none():
    url = f"http://127.0.0.1:{_closed_port()}/api/v1/auth/machine/transaction"
    # Must return None, not raise. Anything else and the caller's retry loop
    # falls through to the catch-all and backs off 5s per attempt.
    assert tu.send_data_to_api(url, {"operations": []}) is None


def test_post_passes_a_timeout():
    """No timeout means a half-open connection hangs the uploader forever."""
    import inspect
    src = inspect.getsource(tu.send_data_to_api)
    assert "timeout=" in src, "send_data_to_api must pass a timeout to requests.post"


if __name__ == "__main__":
    test_refused_connection_returns_none()
    test_post_passes_a_timeout()
    print("ok")
