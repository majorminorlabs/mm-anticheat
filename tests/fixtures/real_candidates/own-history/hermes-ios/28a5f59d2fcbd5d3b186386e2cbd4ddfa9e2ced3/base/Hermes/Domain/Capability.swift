import Foundation

/// Features the mobile bridge reports per host. The UI hides or disables
/// surfaces for anything not listed; no host is assumed to support everything.
nonisolated enum HermesCapability: String, Codable, Sendable, CaseIterable, Identifiable {
    case sessions
    case runs
    /// Missed run events can be replayed from a cursor after reconnecting.
    case runReplay
    case steering
    case stop
    /// Remote approval of pending actions (individual requests may still be non-actionable).
    case approvals
    case profiles
    case cron
    case kanban
    case usage
    case skills
    case tools
    case mcp
    /// Files and images produced by runs.
    case artifacts
    case memory
    case attachments
    case integrations
    case logs

    var id: String { rawValue }

    var label: String {
        switch self {
        case .sessions: "Conversations"
        case .runs: "Runs"
        case .runReplay: "Event replay"
        case .steering: "Steering"
        case .stop: "Stop runs"
        case .approvals: "Remote approvals"
        case .profiles: "Profiles"
        case .cron: "Routines"
        case .kanban: "Kanban"
        case .usage: "Usage"
        case .skills: "Skills"
        case .tools: "Tools"
        case .mcp: "MCP"
        case .artifacts: "Artifacts"
        case .memory: "Memory"
        case .attachments: "Attachments"
        case .integrations: "Integrations"
        case .logs: "Logs"
        }
    }

    var symbol: String {
        switch self {
        case .sessions: "bubble.left.and.bubble.right"
        case .runs: "play.circle"
        case .runReplay: "arrow.counterclockwise"
        case .steering: "arrow.turn.down.right"
        case .stop: "stop.circle"
        case .approvals: "hand.raised"
        case .profiles: "person.2"
        case .cron: "calendar.badge.clock"
        case .kanban: "rectangle.split.3x1"
        case .usage: "chart.bar"
        case .skills: "book.closed"
        case .tools: "wrench.and.screwdriver"
        case .mcp: "point.3.connected.trianglepath.dotted"
        case .artifacts: "shippingbox"
        case .memory: "brain"
        case .attachments: "paperclip"
        case .integrations: "app.connected.to.app.below.fill"
        case .logs: "doc.text.magnifyingglass"
        }
    }
}

extension Set where Element == HermesCapability {
    static let all = Set(HermesCapability.allCases)
}
