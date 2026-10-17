# Windows 打包

使用 `df_local_asr.spec` 在仓库根目录构建本地伴侣。发行目录包含 `df_local_asr/`（程序及运行依赖）和 `config.example.json`；首次启动时会在程序目录生成本机 `config.json`。Whisper 模型不打包，用户首次转写时下载。运行 `packaging/build_release.ps1` 可组装插件+伴侣总 ZIP，并将依赖的许可证文件收集到发行包。发布前仍须核查 Python/FFmpeg 组件许可，并在干净 Windows 环境验证模型下载、实际转写、裁剪和退出流程。Windows 发行包作为 GitHub Release 附件提供，不提交到源码仓库。
