import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const native = String.raw`
import AppKit
import ApplicationServices

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func get(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success else { return nil }
    return value
}

func descendants(_ root: AXUIElement) -> [AXUIElement] {
    [root] + (get(root, "AXChildren") as? [AXUIElement] ?? []).flatMap(descendants)
}

let args = CommandLine.arguments
let pid = pid_t(args[1])!
guard AXIsProcessTrusted() else { fail("Нет доступа к универсальному доступу macOS.") }
let app = AXUIElementCreateApplication(pid)
if args[2] == "window-id" {
    let windows = CGWindowListCopyWindowInfo([.excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    guard let window = windows.first(where: {
        ($0[kCGWindowOwnerPID as String] as? Int) == Int(pid) &&
        ($0[kCGWindowLayer as String] as? Int) == 0 &&
        (($0[kCGWindowBounds as String] as? [String: CGFloat])?["Width"] ?? 0) >= 500
    }), let id = window[kCGWindowNumber as String] else { fail("Окно LiveNote не найдено.") }
    print(id)
    exit(0)
}

let nodes = (get(app, "AXWindows") as? [AXUIElement] ?? []).flatMap(descendants)
for node in nodes {
    let role = get(node, "AXRole") as? String ?? ""
    let keys = role == "AXTextField" || role == "AXTextArea" ? ["AXTitle", "AXDescription"] : ["AXTitle", "AXDescription", "AXValue"]
    let names = keys.compactMap { get(node, $0) as? String }.filter { !$0.isEmpty }
    print(role, names.joined(separator: " | "))
}
`;

export async function compileDesktopDriver(directory) {
  const source = join(directory, 'accessibility.swift');
  const driver = join(directory, 'accessibility');
  await writeFile(source, native);
  await exec('/usr/bin/swiftc', [source, '-o', driver], { timeout: 30_000 });
  return driver;
}

export function desktopWindow(driver, pid) {
  const run = async (...args) => (await exec(driver, [String(pid), ...args], { timeout: 8_000 })).stdout;
  return {
    tree: () => run('tree'),
    async capture(path) {
      const id = (await run('window-id')).trim();
      assert.match(id, /^\d+$/);
      await exec('/usr/sbin/screencapture', ['-x', '-o', '-l', id, path], { timeout: 10_000 });
    }
  };
}
