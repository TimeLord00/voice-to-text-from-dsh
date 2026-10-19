; AutoHotkey v2 example: dictate with Win+; while "vtt serve --dictate" runs in the background.
;
; Why this exists: vtt already registers a global hotkey by itself. This file is for the case where
; you want a *different* key, a key that your keyboard or an application already consumes, or you
; want to trigger dictation from a macro. Start the server first:
;
;   node .\bin\vtt.mjs serve --dictate --port 8791
;
; Then run this script with AutoHotkey v2 (https://www.autohotkey.com/).

#Requires AutoHotkey v2.0
#SingleInstance Force

BASE := "http://127.0.0.1:8791"
TOKEN := ""            ; set this when the server was started with --token
recording := false

; Send one POST to the dictation API and return the response body.
Call(path) {
    global BASE, TOKEN
    request := ComObject("WinHttp.WinHttpRequest.5.1")
    request.Open("POST", BASE . path, false)
    if (TOKEN != "")
        request.SetRequestHeader("Authorization", "Bearer " . TOKEN)
    try {
        request.Send()
    } catch as error {
        TrayTip("voice-to-text", "cannot reach " . BASE . " — is `vtt serve --dictate` running?", 1)
        return ""
    }
    if (request.Status >= 400) {
        TrayTip("voice-to-text", "HTTP " . request.Status . ": " . request.ResponseText, 1)
        return ""
    }
    return request.ResponseText
}

; Extract a JSON string field without pulling in a JSON library.
Field(json, name) {
    if (RegExMatch(json, '"' . name . '"\s*:\s*"((?:[^"\\]|\\.)*)"', &match))
        return StrReplace(StrReplace(match[1], '\"', '"'), '\\', '\')
    return ""
}

#HotIf
; Win+; toggles recording.
#;:: {
    global recording
    if (!recording) {
        Call("/dictate")
        recording := true
        SoundBeep(1200, 80)
    } else {
        response := Call("/dictate/stop")
        recording := false
        SoundBeep(800, 80)
        text := Field(response, "text")
        ; The server already pasted the text; this tooltip is just confirmation of what was heard.
        if (text != "")
            ToolTip(text)
        else
            ToolTip("(nothing recognized)")
        SetTimer(() => ToolTip(), -2500)
    }
}

; Win+Esc drops the current recording.
#Esc:: {
    global recording
    if (recording) {
        Call("/dictate/cancel")
        recording := false
        SoundBeep(400, 120)
    }
}

; Ctrl+Alt+Q quits this script.
^!q:: ExitApp
