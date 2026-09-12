# 自定义 NSIS 安装脚本：
# 安装/卸载时若检测到旧版应用仍在运行，直接在后台静默关闭，
# 不再弹出 "Aurora-Music 正在运行. 点击确定关闭." 的提示框。
!macro customCheckAppRunning
  Push $R0
  Push $R1

  # 先尝试优雅关闭正在运行的应用
  nsExec::Exec `taskkill /IM "${APP_EXECUTABLE_FILENAME}"`
  Pop $R0
  ${if} $R0 == 0
    # 给应用一点时间优雅退出，确保文件不再被占用
    Sleep 500
  ${endIf}

  # 若仍未退出则强制结束，最多重试 5 次
  StrCpy $R1 0
  silentKillLoop:
    nsExec::Exec `taskkill /F /IM "${APP_EXECUTABLE_FILENAME}"`
    Pop $R0
    ${if} $R0 != 0
      # 没有可结束的进程，说明应用未在运行
      Goto silentKillDone
    ${endIf}
    Sleep 300
    IntOp $R1 $R1 + 1
    ${if} $R1 < 5
      Goto silentKillLoop
    ${endIf}

  silentKillDone:

  Pop $R1
  Pop $R0
!macroend
