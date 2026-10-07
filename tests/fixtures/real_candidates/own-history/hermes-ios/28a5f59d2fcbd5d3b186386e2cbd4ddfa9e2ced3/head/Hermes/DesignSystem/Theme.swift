import SwiftUI

/// Semantic colors. State colors are the only saturated hues in the app;
/// everything else leans on system materials and label colors.
enum Theme {
    static let running = Color.accentColor
    static let attention = Color.orange
    static let failure = Color.red
    static let success = Color.green
    static let idle = Color.secondary

    static let codeBackground = Color(uiColor: .secondarySystemBackground)
    static let groupedRow = Color(uiColor: .secondarySystemGroupedBackground)
    static let hairline = Color(uiColor: .separator)
}

extension RunState {
    var tint: Color {
        switch self {
        case .queued: .secondary
        case .running: Theme.running
        case .waitingForApproval, .waitingForInput: Theme.attention
        case .steeringPending: .indigo
        case .stopping: .secondary
        case .completed: Theme.success
        case .failed: Theme.failure
        case .cancelled: .secondary
        case .disconnected: .secondary
        }
    }
}

extension RunOutcome {
    var tint: Color {
        switch self {
        case .succeeded: Theme.success
        case .failed: Theme.failure
        case .cancelled: .secondary
        }
    }
}

extension ConnectionState {
    var tint: Color {
        switch self {
        case .connected: Theme.success
        case .connecting, .reconnecting: Theme.attention
        case .bridgeOffline: .secondary
        case .hermesOffline: Theme.attention
        case .authenticationRequired: Theme.failure
        }
    }
}

extension ProfileStatus {
    var tint: Color {
        switch self {
        case .working: Theme.running
        case .idle: .secondary
        case .needsAttention: Theme.attention
        case .unavailable, .unknown: .secondary
        }
    }
}

extension ProfileTint {
    /// Mid-tone identity colors that read in both light and dark mode.
    var color: Color {
        switch self {
        case .slate: Color(red: 0.45, green: 0.50, blue: 0.56)
        case .teal: Color(red: 0.20, green: 0.58, blue: 0.58)
        case .indigo: Color(red: 0.38, green: 0.40, blue: 0.80)
        case .amber: Color(red: 0.78, green: 0.55, blue: 0.18)
        case .rose: Color(red: 0.76, green: 0.36, blue: 0.46)
        case .olive: Color(red: 0.48, green: 0.55, blue: 0.28)
        }
    }
}

extension TaskStatus {
    var tint: Color {
        switch self {
        case .triage, .todo, .scheduled, .archived: .secondary
        case .review: Theme.attention
        case .ready: .secondary
        case .inProgress: Theme.running
        case .blocked: Theme.attention
        case .completed: Theme.success
        case .failed: Theme.failure
        case .cancelled: .secondary
        }
    }
}

extension AttentionKind {
    var tint: Color {
        switch self {
        case .approval, .blockedTask: Theme.attention
        case .failedRun, .authentication: Theme.failure
        case .hostIssue: .secondary
        }
    }
}

extension LogLevel {
    var tint: Color {
        switch self {
        case .debug: .secondary
        case .info: .accentColor
        case .warning: Theme.attention
        case .error: Theme.failure
        }
    }
}

extension MCPStatus {
    var tint: Color {
        switch self {
        case .connected: Theme.success
        case .connecting: Theme.attention
        case .disconnected: .secondary
        case .error: Theme.failure
        }
    }
}

extension IntegrationStatus {
    var tint: Color {
        switch self {
        case .connected: Theme.success
        case .disconnected: .secondary
        case .error: Theme.failure
        case .notConfigured: Color(uiColor: .tertiaryLabel)
        }
    }
}
