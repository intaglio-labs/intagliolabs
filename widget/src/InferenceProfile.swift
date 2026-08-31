import Foundation

struct InferenceProfile: Decodable {
  let id: String
  let minMemoryGB: Int
  let minCores: Int
  let contextSize: Int
  let parallel: Int
  let batchSize: Int
  let microBatchSize: Int
  let modelsMax: Int
  let summaryConcurrency: Int
  let dualModelSummaries: Bool
}

private struct InferenceProfileFile: Decodable {
  let version: Int
  let profiles: [InferenceProfile]
}

enum InferenceTuning {
  private static let fallback = InferenceProfile(
    id: "compact", minMemoryGB: 0, minCores: 0, contextSize: 32768,
    parallel: 1, batchSize: 512, microBatchSize: 128, modelsMax: 1,
    summaryConcurrency: 1, dualModelSummaries: false)

  static func selected(resourceURL: URL? = Bundle.main.resourceURL) -> InferenceProfile {
    guard let url = resourceURL?.appendingPathComponent("backend/config/inference-profiles.json"),
          let data = try? Data(contentsOf: url),
          let file = try? JSONDecoder().decode(InferenceProfileFile.self, from: data),
          file.version == 1, !file.profiles.isEmpty
    else { return fallback }

    let memoryGB = Int(ProcessInfo.processInfo.physicalMemory / (1024 * 1024 * 1024))
    let cores = ProcessInfo.processInfo.activeProcessorCount
    return file.profiles.reduce(file.profiles[0]) { chosen, candidate in
      memoryGB >= candidate.minMemoryGB && cores >= candidate.minCores ? candidate : chosen
    }
  }
}
