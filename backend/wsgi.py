"""
Production WSGI entrypoint (low-RAM): Waitress single-process server.
"""

from waitress import serve

from server import PORT, create_app, log

app = create_app()

if __name__ == "__main__":
    log.info("Listening on port %d (Waitress WSGI)", PORT)
    serve(
        app,
        host="0.0.0.0",
        port=PORT,
        threads=2,  # low-memory baseline while keeping parallel requests responsive
        connection_limit=100,
        cleanup_interval=30,
        channel_timeout=30,
    )
