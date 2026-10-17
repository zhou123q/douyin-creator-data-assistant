# Windows 打包

使用 `df_local_asr.spec` 在仓库根目录构建本地伴侣。模型文件和用户配置不打包进程序；构建完成后，发布流程需生成 `config.json`，并核对产物内 Python 依赖许可证。Windows 发行包作为 GitHub Release 附件提供，不提交到源码仓库。
