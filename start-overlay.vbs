' start-overlay.vbs - start the floating microphone button with no console window.
'
' Double-click this file (or the shortcut that install.ps1 creates) to get the button next to the text
' caret in any application. Click it to talk, click it again to paste. What it did is written to
' overlay.log next to this file, because a hidden process has nowhere to print.
'
' Close the button with a middle click on it, or from a terminal:
'     node bin\vtt.mjs overlay --stop
Option Explicit

Dim shell, fso, root, node, check, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
node = shell.ExpandEnvironmentStrings("%VTT_NODE%")
If node = "%VTT_NODE%" Then node = "node"

shell.CurrentDirectory = root

' Fail loudly when Node is missing: a hidden process that dies silently looks like a broken tool.
On Error Resume Next
check = shell.Run("""" & node & """ -v", 0, True)
If Err.Number <> 0 Then check = 1
On Error GoTo 0

If check <> 0 Then
  MsgBox "Node.js 20 or newer was not found." & vbCrLf & vbCrLf & _
         "Run install.ps1 in this folder, or set VTT_NODE to the full path of node.exe:" & _
         vbCrLf & root, 16, "Voice to Text"
  WScript.Quit 1
End If

command = """" & node & """ """ & root & "\bin\vtt.mjs"" overlay --log"
' The second argument 0 is the whole point: no console window for the button process.
shell.Run command, 0, False
