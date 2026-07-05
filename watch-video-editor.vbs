Set shell = CreateObject("WScript.Shell")
script = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""C:\Users\김성철\video-editor\watch-video-editor.ps1"""
shell.Run script, 0, False
