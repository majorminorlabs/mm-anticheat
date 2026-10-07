import SwiftUI

/// Hermes profiles presented as persistent bots.
struct BotsView: View {
    @Environment(ProfileStore.self) private var profiles
    @Environment(ConnectionStore.self) private var connection
    @Environment(ActivityStore.self) private var activity

    var body: some View {
        LoadableContent(phase: profiles.phase, isEmpty: profiles.profiles.isEmpty, hasData: !profiles.profiles.isEmpty,
                        retry: { await profiles.refresh() }) {
            List {
                ConnectionNoticeSection()
                if connection.supports(.profiles) {
                    Section {
                        if profiles.bots.isEmpty {
                            Text("No bots available on this host.")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        ForEach(profiles.bots) { profile in
                            NavigationLink(value: Route.profile(profile.id)) {
                                BotRow(profile: profile)
                            }
                        }
                    } header: {
                        Text("Bots")
                    }
                }

                if let defaultProfile = profiles.sorted.first(where: { $0.isDefault && $0.isBotMode != true }) {
                    Section {
                        NavigationLink(value: Route.profile(defaultProfile.id)) {
                            BotRow(profile: defaultProfile)
                        }
                    } header: {
                        Text("Default Profile")
                    } footer: {
                        if !connection.supports(.profiles) {
                            Text("This host exposes a single profile.")
                        }
                    }
                }

                Section {
                    HStack(spacing: 12) {
                        Image(systemName: "person.3")
                            .foregroundStyle(.tertiary)
                            .frame(width: 36)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Groups")
                                .foregroundStyle(.secondary)
                            Text("Shared conversations between several bots")
                                .font(.subheadline)
                                .foregroundStyle(.tertiary)
                        }
                        Spacer()
                        Text("Later")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.tertiary)
                    }
                    .accessibilityElement(children: .combine)
                } footer: {
                    Text("Group conversations are not supported by this mobile client yet.")
                }
            }
            .refreshable { await profiles.refresh() }
        } empty: {
            ContentUnavailableView("No Bots", systemImage: "person.2",
                                   description: Text("Bots exposed by the Studio appear here."))
        }
        .navigationTitle("Bots")
        .task {
            while !Task.isCancelled {
                await profiles.refresh()
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
            }
        }
    }
}

struct BotRow: View {
    var profile: Profile

    @Environment(ActivityStore.self) private var activity

    var body: some View {
        let run = activity.run(profile.currentRunID).flatMap { $0.state.isActive ? $0 : nil }
        HStack(spacing: 12) {
            ProfileAvatarWithStatus(profile: profile, size: 40)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(profile.name).font(.body.weight(.semibold))
                    Text(profile.role).font(.subheadline).foregroundStyle(.secondary)
                }
                HStack(spacing: 5) {
                    if let last = profile.lastActiveAt, profile.status == .unknown {
                        Text("Last active \(last, style: .relative) ago").foregroundStyle(.secondary)
                    } else { Text(profile.status.label) }

                    if let run {
                        Text("· \(run.title)").foregroundStyle(.secondary)
                    }
                }
                .font(.subheadline)
                .lineLimit(1)
            }
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
    }
}

#Preview {
    NavigationStack { BotsView().routeDestinations() }
        .previewEnvironment()
}
