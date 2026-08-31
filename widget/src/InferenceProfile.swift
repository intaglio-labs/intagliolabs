import Foundation
import IOKit

struct InferenceProfile: Decodable {
  let id: String
  let minMemoryGB: Int
  let minCores: Int
  let minGPUCores: Int
  let modelTier: String
  let contextSize: Int
  let parallel: Int
  let batchSize: Int
  let microBatchSize: Int
  let modelsMax: Int
  let summaryConcurrency: Int
  let dualModelSummaries: Bool
}

struct MachineCapabilities {
  let memoryBytes: UInt64
  let cpuCores: Int
  let gpuCores: Int

  static let current: MachineCapabilities = {
    MachineCapabilities(
      memoryBytes: ProcessInfo.processInfo.physicalMemory,
      cpuCores: ProcessInfo.processInfo.activeProcessorCount,
      gpuCores: detectedGPUCores())
  }()

  /// Apple Silicon publishes the physical GPU count on its AGX registry node.
  /// Intel/virtual Macs may not; zero deliberately means "unknown", so the
  /// selector falls back to RAM + CPU instead of treating missing metadata as
  /// a zero-core GPU.
  private static func detectedGPUCores() -> Int {
    let service = IOServiceGetMatchingService(
      kIOMainPortDefault, IOServiceMatching("AGXAccelerator"))
    guard service != 0 else { return 0 }
    defer { IOObjectRelease(service) }
    guard let value = IORegistryEntryCreateCFProperty(
      service, "gpu-core-count" as CFString, kCFAllocatorDefault, 0
    )?.takeRetainedValue() as? NSNumber else { return 0 }
    return max(0, value.intValue)
  }
}

private struct InferenceProfileFile: Decodable {
  let version: Int
  let profiles: [InferenceProfile]
}

enum InferenceTuning {
  private static let fallback = InferenceProfile(
    id: "compact", minMemoryGB: 0, minCores: 0, minGPUCores: 0,
    modelTier: "4b", contextSize: 32768,
    parallel: 1, batchSize: 512, microBatchSize: 128, modelsMax: 1,
    summaryConcurrency: 1, dualModelSummaries: false)

  static func selected(
    resourceURL: URL? = Bundle.main.resourceURL,
    capabilities: MachineCapabilities = .current
  ) -> InferenceProfile {
    guard let url = resourceURL?.appendingPathComponent("backend/config/inference-profiles.json"),
          let data = try? Data(contentsOf: url),
          let file = try? JSONDecoder().decode(InferenceProfileFile.self, from: data),
          file.version == 1, !file.profiles.isEmpty
    else { return fallback }

    let memoryGB = Int(capabilities.memoryBytes / (1024 * 1024 * 1024))
    return file.profiles.reduce(file.profiles[0]) { chosen, candidate in
      let graphicsFit = capabilities.gpuCores == 0
        || capabilities.gpuCores >= candidate.minGPUCores
      return memoryGB >= candidate.minMemoryGB
        && capabilities.cpuCores >= candidate.minCores
        && graphicsFit ? candidate : chosen
    }
  }
}
