import Foundation

/// A Hermes profile: a persistent identity with its own model, skills,
/// memory and SOUL. The Bots tab presents profiles as "bots"; there is no
/// separate bot object on the backend. Richer Bot Mode features can extend
/// this type later.
nonisolated struct Profile: Identifiable, Hashable, Codable, Sendable {
    static let defaultID = "default"

    let id: String
    var name: String
    var role: String
    var summary: String
    var tint: ProfileTint
    var model: ModelRef
    var status: ProfileStatus
    var hostID: String
    var isDefault: Bool
    var skillIDs: [String]
    var toolsets: [String]
    var mcpServerIDs: [String]
    /// Configuration metadata. Any of these may be absent if the host doesn't expose them.
    var memorySummary: String?
    var memoryEntryCount: Int?
    var soulSummary: String?
    var configPath: String?
    var currentRunID: String?

    var initials: String { String(name.prefix(1)).uppercased() }
}

nonisolated enum ProfileStatus: String, Codable, Sendable {
    case working, idle, needsAttention, unavailable

    var label: String {
        switch self {
        case .working: "Working"
        case .idle: "Idle"
        case .needsAttention: "Needs attention"
        case .unavailable: "Unavailable"
        }
    }
}

/// Muted identity colors. Deliberately few and desaturated.
nonisolated enum ProfileTint: String, Codable, Sendable, CaseIterable {
    case slate, teal, indigo, amber, rose, olive
}
