import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// MCP por stdio. O processo fica vivo durante a execução do Codex e guarda os índices
// dos elementos de acessibilidade da última leitura de cada aplicativo.
var elements: [String: AXUIElement] = [:]
var askedForAccessibility = false
var askedForScreenRecording = false

func send(_ message: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(message),
          let data = try? JSONSerialization.data(withJSONObject: message) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}

func tool(_ name: String, _ description: String, _ properties: [String: Any], _ required: [String]) -> [String: Any] {
    ["name": name, "description": description, "inputSchema": [
        "type": "object", "properties": properties, "required": required, "additionalProperties": false
    ]]
}

func field(_ description: String, _ type: String = "string") -> [String: String] {
    ["type": type, "description": description]
}

let appField = field("Nome, identificador ou caminho do aplicativo")
let indexField = field("Índice do elemento retornado por get_app_state")
let tools: [[String: Any]] = [
    tool("list_apps", "Lista os aplicativos em execução no Mac.", [:], []),
    tool("open_app", "Abre um aplicativo instalado no Mac.", ["app": appField], ["app"]),
    tool("get_app_state", "Lê os elementos acessíveis de um aplicativo e, se solicitado, captura a tela.", [
        "app": appField, "include_screenshot": field("Incluir imagem da tela; padrão: true", "boolean")
    ], ["app"]),
    tool("get_screen_state", "Captura a tela do Mac para inspecionar aplicativos e janelas.", [:], []),
    tool("click", "Clica num elemento acessível ou em coordenadas da tela.", [
        "app": appField, "element_index": indexField,
        "x": field("Coordenada horizontal da tela", "number"), "y": field("Coordenada vertical da tela", "number"),
        "click_count": field("Número de cliques; padrão: 1", "integer")
    ], ["app"]),
    tool("set_value", "Define o valor de um campo acessível.", [
        "app": appField, "element_index": indexField, "value": field("Novo valor")
    ], ["app", "element_index", "value"]),
    tool("press_key", "Pressiona tecla ou combinação, por exemplo Command+L ou Return.", [
        "app": appField, "key": field("Tecla ou combinação")
    ], ["app", "key"]),
    tool("type_text", "Digita texto no aplicativo ativo.", [
        "app": appField, "text": field("Texto literal")
    ], ["app", "text"]),
    tool("scroll", "Rola a tela no aplicativo.", [
        "app": appField, "direction": field("up, down, left ou right"),
        "pages": field("Quantidade de páginas; padrão: 1", "number")
    ], ["app", "direction"]),
    tool("drag", "Arrasta o ponteiro entre duas coordenadas da tela.", [
        "app": appField,
        "from_x": field("X inicial", "number"), "from_y": field("Y inicial", "number"),
        "to_x": field("X final", "number"), "to_y": field("Y final", "number")
    ], ["app", "from_x", "from_y", "to_x", "to_y"])
]

func textResult(_ text: String, error: Bool = false) -> [String: Any] {
    ["content": [["type": "text", "text": text]], "isError": error]
}

func errorResult(_ text: String) -> [String: Any] { textResult(text, error: true) }

func appFor(_ name: String) -> NSRunningApplication? {
    let needle = name.lowercased()
    return NSWorkspace.shared.runningApplications.first {
        $0.bundleIdentifier?.lowercased() == needle ||
        $0.localizedName?.lowercased() == needle ||
        $0.bundleURL?.path.lowercased() == needle
    }
}

func attr(_ element: AXUIElement, _ name: CFString) -> Any? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name, &value) == .success else { return nil }
    return value
}

func label(_ element: AXUIElement, _ name: CFString) -> String? {
    guard let value = attr(element, name) as? String, !value.isEmpty else { return nil }
    return value.replacingOccurrences(of: "\n", with: " ").prefix(300).description
}

func position(_ element: AXUIElement) -> CGPoint? {
    guard let raw = attr(element, kAXPositionAttribute as CFString) else { return nil }
    let value = raw as! AXValue
    guard AXValueGetType(value) == .cgPoint else { return nil }
    var point = CGPoint.zero
    return AXValueGetValue(value, .cgPoint, &point) ? point : nil
}

func size(_ element: AXUIElement) -> CGSize? {
    guard let raw = attr(element, kAXSizeAttribute as CFString) else { return nil }
    let value = raw as! AXValue
    guard AXValueGetType(value) == .cgSize else { return nil }
    var valueSize = CGSize.zero
    return AXValueGetValue(value, .cgSize, &valueSize) ? valueSize : nil
}

func tree(_ root: AXUIElement, _ prefix: String, _ depth: Int, _ lines: inout [String], _ seen: inout Int) {
    if depth > 9 || seen >= 350 { return }
    let index = "\(prefix)-\(seen)"
    seen += 1
    elements[index] = root
    let role = label(root, kAXRoleAttribute as CFString) ?? "element"
    let title = label(root, kAXTitleAttribute as CFString)
    let value = role == "AXSecureTextField" ? nil : label(root, kAXValueAttribute as CFString)
    let description = label(root, kAXDescriptionAttribute as CFString)
    let parts = [title, value, description].compactMap { $0 }.filter { !$0.isEmpty }
    let frame = position(root).flatMap { point -> String? in
        guard let s = size(root) else { return nil }
        return "(\(Int(point.x)),\(Int(point.y)) \(Int(s.width))x\(Int(s.height)))"
    } ?? ""
    lines.append("\(String(repeating: "  ", count: depth))[\(index)] \(role) \(parts.joined(separator: " | ")) \(frame)")
    if let children = attr(root, kAXChildrenAttribute as CFString) as? [AXUIElement] {
        for child in children { tree(child, prefix, depth + 1, &lines, &seen) }
    }
}

func screenshot() -> [String: Any] {
    if !CGPreflightScreenCaptureAccess() {
        if !askedForScreenRecording {
            askedForScreenRecording = true
            _ = CGRequestScreenCaptureAccess()
        }
        return errorResult("Conceda Gravação da Tela ao aplicativo mostrado pelo macOS em Ajustes do Sistema > Privacidade e Segurança > Gravação da Tela e tente novamente.")
    }
    let file = FileManager.default.temporaryDirectory.appendingPathComponent("ovseer-screen-\(UUID().uuidString).png")
    defer { try? FileManager.default.removeItem(at: file) }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    process.arguments = ["-x", "-t", "png", file.path]
    do {
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0, let data = try? Data(contentsOf: file), !data.isEmpty else {
            return errorResult("Não foi possível capturar a tela. Verifique a permissão de Gravação da Tela do Ovseer em Ajustes do Sistema.")
        }
        return ["content": [["type": "image", "data": data.base64EncodedString(), "mimeType": "image/png"]], "isError": false]
    } catch {
        return errorResult("Falha ao capturar a tela: \(error.localizedDescription)")
    }
}

func requireAccessibility() -> String? {
    if AXIsProcessTrusted() { return nil }
    if !askedForAccessibility {
        askedForAccessibility = true
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
    }
    return "Conceda Acessibilidade ao aplicativo mostrado pelo macOS em Ajustes do Sistema > Privacidade e Segurança > Acessibilidade e tente novamente."
}

func activate(_ app: NSRunningApplication) -> Bool {
    _ = app.activate()
    for _ in 0..<10 {
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier { return true }
        usleep(100_000)
    }
    return false
}

func mouse(_ type: CGEventType, _ point: CGPoint) {
    CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point,
            mouseButton: .left)?.post(tap: .cghidEventTap)
}

func number(_ args: [String: Any], _ key: String) -> Double? { (args[key] as? NSNumber)?.doubleValue }

func keyCode(_ key: String) -> CGKeyCode? {
    let codes: [String: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
        "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19,
        "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27,
        "8": 28, "0": 29, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38,
        "k": 40, "n": 45, "m": 46, "space": 49, "return": 36, "enter": 36,
        "tab": 48, "escape": 53, "esc": 53, "delete": 51, "backspace": 51,
        "up": 126, "down": 125, "left": 123, "right": 124
    ]
    return codes[key.lowercased()]
}

func runTool(_ name: String, _ args: [String: Any]) -> [String: Any] {
    if name == "list_apps" {
        let apps = NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular }
            .map { "\($0.localizedName ?? "Sem nome") — \($0.bundleIdentifier ?? "sem identificador")" }
            .sorted()
        return textResult(apps.joined(separator: "\n"))
    }
    if name == "get_screen_state" { return screenshot() }
    guard let appName = args["app"] as? String, !appName.isEmpty else { return errorResult("Informe o aplicativo.") }
    if name == "open_app" {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        process.arguments = ["-a", appName]
        do {
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus == 0 ? textResult("Aplicativo aberto: \(appName)") : errorResult("Não foi possível abrir: \(appName)")
        } catch { return errorResult(error.localizedDescription) }
    }
    guard let running = appFor(appName) else { return errorResult("Aplicativo não está em execução: \(appName)") }
    if name == "get_app_state" {
        guard let problem = requireAccessibility() else {
            elements = elements.filter { !$0.key.hasPrefix("\(running.processIdentifier)-") }
            var lines: [String] = []
            var seen = 0
            tree(AXUIElementCreateApplication(running.processIdentifier), String(running.processIdentifier), 0, &lines, &seen)
            var content: [[String: Any]] = [["type": "text", "text": lines.joined(separator: "\n")]]
            if args["include_screenshot"] as? Bool != false {
                let image = screenshot()
                if let imageParts = image["content"] as? [[String: Any]], image["isError"] as? Bool == false {
                    content.append(contentsOf: imageParts)
                } else if let message = (image["content"] as? [[String: Any]])?.first { content.append(message) }
            }
            return ["content": content, "isError": false]
        }
        return errorResult(problem)
    }
    guard let problem = requireAccessibility() else {
        switch name {
        case "click":
            guard activate(running) else { return errorResult("Não foi possível ativar o aplicativo; nenhum clique foi enviado.") }
            if let index = args["element_index"] as? String,
               index.hasPrefix("\(running.processIdentifier)-"), let element = elements[index] {
                if AXUIElementPerformAction(element, kAXPressAction as CFString) == .success { return textResult("Clique realizado.") }
                if let point = position(element), let s = size(element) {
                    let center = CGPoint(x: point.x + s.width / 2, y: point.y + s.height / 2)
                    mouse(.leftMouseDown, center); mouse(.leftMouseUp, center)
                    return textResult("Clique realizado.")
                }
                return errorResult("O elemento não aceita clique.")
            }
            guard let x = number(args, "x"), let y = number(args, "y") else { return errorResult("Informe element_index ou x e y.") }
            let point = CGPoint(x: x, y: y)
            for _ in 0..<min(max(Int(number(args, "click_count") ?? 1), 1), 3) {
                mouse(.leftMouseDown, point); mouse(.leftMouseUp, point)
            }
            return textResult("Clique realizado.")
        case "set_value":
            guard let index = args["element_index"] as? String,
                  index.hasPrefix("\(running.processIdentifier)-"), let element = elements[index],
                  let value = args["value"] as? String else { return errorResult("Índice ou valor inválido. Leia o aplicativo novamente.") }
            let result = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFTypeRef)
            return result == .success ? textResult("Valor definido.") : errorResult("Não foi possível definir o valor (AXError \(result.rawValue)).")
        case "press_key":
            guard let raw = args["key"] as? String else { return errorResult("Informe a tecla.") }
            let pieces = raw.split(separator: "+").map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
            guard let last = pieces.last, let code = keyCode(last) else { return errorResult("Tecla não reconhecida: \(raw)") }
            var flags: CGEventFlags = []
            for part in pieces.dropLast() {
                switch part {
                case "command", "cmd", "meta": flags.insert(.maskCommand)
                case "control", "ctrl": flags.insert(.maskControl)
                case "option", "alt": flags.insert(.maskAlternate)
                case "shift": flags.insert(.maskShift)
                default: return errorResult("Modificador não reconhecido: \(part)")
                }
            }
            guard activate(running) else { return errorResult("Não foi possível ativar o aplicativo; nenhuma tecla foi enviada.") }
            for down in [true, false] {
                if let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down) {
                    event.flags = flags
                    event.post(tap: .cghidEventTap)
                }
            }
            return textResult("Tecla pressionada.")
        case "type_text":
            guard let value = args["text"] as? String else { return errorResult("Informe o texto.") }
            guard activate(running) else { return errorResult("Não foi possível ativar o aplicativo; nenhum texto foi digitado.") }
            for character in value {
                let units = Array(String(character).utf16)
                for down in [true, false] {
                    if let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down) {
                        units.withUnsafeBufferPointer { buffer in
                            if let pointer = buffer.baseAddress {
                                event.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: pointer)
                            }
                        }
                        event.post(tap: .cghidEventTap)
                    }
                }
            }
            return textResult("Texto digitado.")
        case "scroll":
            guard let direction = args["direction"] as? String else { return errorResult("Informe a direção.") }
            let amount = Int32(min(max(number(args, "pages") ?? 1, 0.1), 10) * 8)
            let vertical: Int32 = direction == "up" ? amount : direction == "down" ? -amount : 0
            let horizontal: Int32 = direction == "left" ? amount : direction == "right" ? -amount : 0
            guard vertical != 0 || horizontal != 0 else { return errorResult("Direção inválida.") }
            guard activate(running) else { return errorResult("Não foi possível ativar o aplicativo; nenhuma rolagem foi enviada.") }
            CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2,
                    wheel1: vertical, wheel2: horizontal, wheel3: 0)?.post(tap: .cghidEventTap)
            return textResult("Rolagem realizada.")
        case "drag":
            guard let x1 = number(args, "from_x"), let y1 = number(args, "from_y"),
                  let x2 = number(args, "to_x"), let y2 = number(args, "to_y") else { return errorResult("Coordenadas inválidas.") }
            guard activate(running) else { return errorResult("Não foi possível ativar o aplicativo; nenhum arrasto foi enviado.") }
            let start = CGPoint(x: x1, y: y1), end = CGPoint(x: x2, y: y2)
            mouse(.leftMouseDown, start)
            for step in 1...10 {
                let t = Double(step) / 10
                mouse(.leftMouseDragged, CGPoint(x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t))
                usleep(15_000)
            }
            mouse(.leftMouseUp, end)
            return textResult("Arrasto realizado.")
        default: return errorResult("Ferramenta desconhecida: \(name)")
        }
    }
    return errorResult(problem)
}

while let line = readLine() {
    guard let data = line.data(using: .utf8),
          let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let method = request["method"] as? String else { continue }
    guard let id = request["id"] else { continue }
    var result: [String: Any]
    switch method {
    case "initialize":
        result = ["protocolVersion": "2025-06-18", "capabilities": ["tools": [:]],
                  "serverInfo": ["name": "Ovseer Computer Use", "version": "1.0.0"]]
    case "ping": result = [:]
    case "tools/list": result = ["tools": tools]
    case "tools/call":
        let params = request["params"] as? [String: Any] ?? [:]
        result = runTool(params["name"] as? String ?? "", params["arguments"] as? [String: Any] ?? [:])
    default:
        send(["jsonrpc": "2.0", "id": id, "error": ["code": -32601, "message": "Método desconhecido"]])
        continue
    }
    send(["jsonrpc": "2.0", "id": id, "result": result])
}
