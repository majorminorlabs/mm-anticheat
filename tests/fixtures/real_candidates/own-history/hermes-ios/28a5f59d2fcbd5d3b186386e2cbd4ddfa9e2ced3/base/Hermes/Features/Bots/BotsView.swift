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
                            Text("No bots yet. Create profiles on the host with `hermes profile create`.")
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

                if let defaultProfile = profiles.sorted.first(where: \.isDefault) {
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
                    Text("Multi-bot rooms aren't available in Hermes yet. They'll appear here when the host supports them.")
                }
            }
            .refreshable { await profiles.refresh() }
        } empty: {
            ContentUnavailableView("No Profiles", systemImage: "person.2",
                                   description: Text("Profiles configured on the host appear here as bots."))
        }
        .navigationTitle("Bots")
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
                    Text(profile.status.label)
                        .foregroundStyle(profile.status == .idle ? .secondary : profile.status.tint)
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
