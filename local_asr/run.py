import uvicorn
import webbrowser
from threading import Timer
from server import app


if __name__ == "__main__":
    Timer(1.2, lambda: webbrowser.open("http://127.0.0.1:8765/")).start()
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="info")
