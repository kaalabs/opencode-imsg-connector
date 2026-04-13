import Dispatch
import Foundation

let launcherBinaryName = "OWPenbotBackgroundLauncher"

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}

func bundledServiceScriptPath() -> String {
  guard let resourceURL = Bundle.main.resourceURL else {
    fail("Bundle resource directory not found")
  }

  let serviceURL = resourceURL
    .appendingPathComponent("service", isDirectory: true)
    .appendingPathComponent("run-all-heartbeat-service.js", isDirectory: false)

  guard FileManager.default.isReadableFile(atPath: serviceURL.path) else {
    fail("Bundled service script not found: \(serviceURL.path)")
  }

  return serviceURL.path
}

func parseArguments(_ argv: [String]) -> (String, [String]) {
  var nodeBin = ProcessInfo.processInfo.environment["NODE_BIN"] ?? "/opt/homebrew/bin/node"
  var forwarded: [String] = []

  var index = 0
  while index < argv.count {
    let arg = argv[index]

    if arg == "--node-bin" {
      guard index + 1 < argv.count else {
        fail("--node-bin requires a value")
      }

      nodeBin = argv[index + 1]
      index += 2
      continue
    }

    forwarded.append(arg)
    index += 1
  }

  return (nodeBin, forwarded)
}

func installSignalForwarder(for signalValue: Int32, child: Process) -> DispatchSourceSignal {
  signal(signalValue, SIG_IGN)

  let source = DispatchSource.makeSignalSource(signal: signalValue, queue: DispatchQueue.global())
  source.setEventHandler {
    if child.isRunning {
      child.terminate()
    }
  }
  source.resume()
  return source
}

let executablePath = CommandLine.arguments.first ?? ""
if !executablePath.hasSuffix("/Contents/MacOS/\(launcherBinaryName)") {
  fail("Launcher must run from within the app bundle")
}

let (nodeBin, forwardedArguments) = parseArguments(Array(CommandLine.arguments.dropFirst()))
let child = Process()
child.executableURL = URL(fileURLWithPath: nodeBin)
child.arguments = [bundledServiceScriptPath()] + forwardedArguments
child.environment = ProcessInfo.processInfo.environment
child.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
child.standardOutput = FileHandle.standardOutput
child.standardError = FileHandle.standardError
child.standardInput = nil

let terminationGroup = DispatchGroup()
terminationGroup.enter()

child.terminationHandler = { _ in
  terminationGroup.leave()
}

let sigintForwarder = installSignalForwarder(for: SIGINT, child: child)
let sigtermForwarder = installSignalForwarder(for: SIGTERM, child: child)

do {
  try child.run()
} catch {
  fail("Failed to start bundled service: \(error.localizedDescription)")
}

terminationGroup.wait()
sigintForwarder.cancel()
sigtermForwarder.cancel()

if child.terminationReason == .uncaughtSignal {
  exit(128 + child.terminationStatus)
}

exit(child.terminationStatus)
