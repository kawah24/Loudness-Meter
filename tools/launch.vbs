' Loudness Meter launcher.
' Starts the local server hidden (so the microphone works), waits for it, then
' opens the page. If the server cannot start, falls back to the file itself.

Option Explicit

Dim sh, fso, shellApp, here, root, url, fileUrl, ok, i

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
Set shellApp = CreateObject("Shell.Application")

here = fso.GetParentFolderName(WScript.ScriptFullName)
root = fso.GetParentFolderName(here)
url = "http://127.0.0.1:8787/LoudnessMeter.html"
fileUrl = root & "\LoudnessMeter.html"

' start the server hidden; it exits on its own when idle
' prefer the system Python launcher over whatever happens to be first on PATH
Dim pyCmd
pyCmd = "python"
If fso.FileExists(sh.ExpandEnvironmentStrings("%WINDIR%") & "\py.exe") Then pyCmd = "py -3"

On Error Resume Next
sh.Run "cmd /c cd /d """ & root & """ && " & pyCmd & " """ & here & "\serve.py""", 0, False
On Error GoTo 0

' wait up to ~4 s for it to answer
ok = False
For i = 1 To 20
  If Probe(url) Then
    ok = True
    Exit For
  End If
  WScript.Sleep 200
Next

If ok Then
  ' System audio needs a Chromium browser. Edge ships with Windows, so prefer it,
  ' and --app opens a plain window with no tabs or address bar.
  ' (ExpandEnvironmentStrings cannot expand %ProgramFiles(x86)% - it has brackets.)
  Dim edge, chrome, pf
  pf = sh.ExpandEnvironmentStrings("%ProgramFiles%")
  edge = pf & "\Microsoft\Edge\Application\msedge.exe"
  If Not fso.FileExists(edge) Then edge = sh.ExpandEnvironmentStrings("%SystemDrive%") & "\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
  chrome = pf & "\Google\Chrome\Application\chrome.exe"

  If fso.FileExists(edge) Then
    sh.Run """" & edge & """ --app=" & url & " --window-size=1600,1000", 1, False
  ElseIf fso.FileExists(chrome) Then
    sh.Run """" & chrome & """ --app=" & url & " --window-size=1600,1000", 1, False
  Else
    shellApp.ShellExecute url
  End If
Else
  shellApp.ShellExecute fileUrl
End If

Function Probe(u)
  Dim http
  Probe = False
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  If Err.Number <> 0 Then
    Err.Clear
    Set http = CreateObject("MSXML2.ServerXMLHTTP")
  End If
  http.setTimeouts 400, 400, 400, 400
  http.open "GET", u, False
  http.send
  If Err.Number = 0 Then Probe = (http.status = 200)
  On Error GoTo 0
End Function
