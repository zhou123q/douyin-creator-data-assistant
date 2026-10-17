# 本地伴侣（源码运行）

要求 Windows 和 Python 3.12。模型不随源码仓库分发。

1. 在本目录创建虚拟环境：`py -3.12 -m venv .venv`。
2. 安装依赖：`.venv\Scripts\python -m pip install -r requirements.txt`。
3. 首次启动会从 `config.example.json` 创建本机配置 `config.json`；也可以手动复制。
4. 运行 `start_dev.bat`，或执行 `.venv\Scripts\python run.py`。
5. 浏览器打开 `http://127.0.0.1:8765/`，首次转写时按页面提示下载模型。

模型：[`Systran/faster-whisper-medium`](https://huggingface.co/Systran/faster-whisper-medium)，约 1.43 GB。可在伴侣页面自动下载，也可使用“选择已有模型目录”。模型文件只保存在本机；请遵循模型卡和上游许可。

本服务只绑定 `127.0.0.1:8765`。转写和视频片段处理在本机执行。AI 分析需要用户自行提供兼容服务的 API Key；密钥保存在本机 `config.json`，不要提交到仓库。

## Windows 打包

从仓库根目录安装 PyInstaller 后运行：

```text
pyinstaller --noconfirm --distpath build/release --workpath build/pyinstaller packaging/df_local_asr.spec
```

打包结果还需要在 EXE 同目录提供经用户填写的 `config.json`。正式发布前应核对 Python 依赖的许可证，并测试干净 Windows 环境中的安装包。
