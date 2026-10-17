import os
import uvicorn
import webbrowser
from threading import Timer
from server import app


if __name__ == "__main__":
    port = int(os.environ.get("DF_ASR_PORT", "8765"))
    if os.environ.get("DF_ASR_NO_BROWSER") != "1":
        Timer(1.2, lambda: webbrowser.open(f"http://127.0.0.1:{port}/")).start()
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
