import SwiftUI

/// A bot (Hermes profile): identity, what it's doing, its conversations,
/// runs, routines, skills and configuration metadata.
struct ProfileDetailView: View {
    var profileID: String

    @Environment(AppEnvironment.self) private var environment
    @Environment(ProfileStore.self) private var profiles
    @Environment(ActivityStore.self) private var activity
    @Environment(ConversationListStore.self) private var conversations
    @Environment(RoutineStore.self) private var routines
    @Environment(TaskStore.self) private var tasks
    @Environment(ConnectionStore.self) private var connection
    @Environment(AppRouter.self) private var router
    @State private var skills = Resource<[Skill]>()
    @State private var editing = false
    @State private var creatingTask = false

    var body: some View {
        Group {
            if let profile = profiles.profile(profileID) {
                content(profile)
            } else {
                ContentUnavailableView("Profile Not Found", systemImage: "person.crop.circle.badge.questionmark")
            }
        }
        .navigationTitle(profiles.profile(profileID)?.name ?? "Bot")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if !connection.supports(.botMode) && connection.supports(.skills) { await skills.load { try await environment.client.skills.listSkills() } }
            repeat {
                await profiles.loadProfile(profileID)
                guard connection.supports(.botMode) else { return }
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
            } while !Task.isCancelled
        }
    }

    private func content(_ profile: Profile) -> some View {
        let currentRun = activity.run(profile.currentRunID).flatMap { $0.state.isActive ? $0 : nil }
        let profileConversations = conversations.conversations(forProfile: profile.id)
        let recentRuns = activity.runs(forProfile: profile.id).filter(\.state.isTerminal)
        let profileRoutines = routines.routines(forProfile: profile.id)
        let openTasks = tasks.tasks(forProfile: profile.id).filter { $0.status != .completed && $0.status != .cancelled }

        return List {
            Section {
                header(profile)
            }
            Section {
                actions(profile)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
            }

            if let currentRun {
                Section("Now") {
                    NavigationLink(value: Route.run(currentRun.id)) { RunRow(run: currentRun) }
                }
            }

            if profile.isBotMode != true { Section {
                if profileConversations.isEmpty {
                    Text("No conversations yet").foregroundStyle(.secondary)
                }
                ForEach(profileConversations.prefix(4)) { conversation in
                    NavigationLink(value: Route.conversation(conversation.id)) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(conversation.title).lineLimit(1)
                            Text(conversation.preview)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                }
            } header: {
                SectionHeader(title: "Conversations") {
                    if profileConversations.count > 4 {
                        Text("\(profileConversations.count)").foregroundStyle(.secondary)
                    }
                }
            }

            }
            if !openTasks.isEmpty {
                Section("Tasks") {
                    ForEach(openTasks.prefix(4)) { task in
                        NavigationLink(value: Route.task(task.id)) { TaskRow(task: task) }
                    }
                }
            }

            if !recentRuns.isEmpty {
                Section("Recent Runs") {
                    ForEach(recentRuns.prefix(5)) { run in
                        NavigationLink(value: Route.run(run.id)) { RecentRunRow(run: run) }
                    }
                }
            }

            if !profileRoutines.isEmpty {
                Section("Routines") {
                    ForEach(profileRoutines) { routine in
                        NavigationLink(value: Route.routine(routine.id)) { UpcomingRow(routine: routine) }
                    }
                }
            }

            skillsSection(profile)

            if profile.memorySummary != nil || profile.memoryEntryCount != nil {
                Section {
                    if let summary = profile.memorySummary { Text(summary) }
                    if profile.isBotMode != true && connection.supports(.memory) {
                        NavigationLink(value: Route.memory) {
                            LabeledContent("Entries", value: profile.memoryEntryCount.map(String.init) ?? "—")
                        }
                    }
                } header: {
                    Text("Memory")
                }
            }

            if let names = profile.routinesMetadata, !names.isEmpty {
                Section("Routines") { ForEach(names, id: \.self) { Text($0) } }
            }
            if !profile.mcpServerIDs.isEmpty {
                Section("Connectors (MCP)") { ForEach(profile.mcpServerIDs, id: \.self) { Text($0) } }
            }
            if let names = profile.pluginsMetadata, !names.isEmpty {
                Section("Plugins") { ForEach(names, id: \.self) { Text($0) } }
            }
            Section("Profile") {
                if let soul = profile.soulSummary {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("SOUL").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                        Text(soul)
                    }
                    .padding(.vertical, 2)
                }
                if profile.modelAvailable != false { KeyValueRow(label: "Model", value: profile.model.detailedLabel) }
                if !profile.toolsets.isEmpty {
                    KeyValueRow(label: "Toolsets", value: profile.toolsets.joined(separator: ", "))
                }
                if let path = profile.configPath {
                    KeyValueRow(label: "Config", value: path, monospaced: true)
                }
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if environment.simulator != nil { Button("Edit") { editing = true } }
            }
        }
        .sheet(isPresented: $editing) {
            EditProfileView(profile: profile, skills: skills.value ?? [])
        }
        .sheet(isPresented: $creatingTask) {
            NewTaskSheet(assigneeProfileID: profile.id)
        }
    }

    private func header(_ profile: Profile) -> some View {
        HStack(alignment: .top, spacing: 14) {
            ProfileAvatar(profile: profile, size: 56)
            VStack(alignment: .leading, spacing: 4) {
                Text(profile.name).font(.title2.weight(.semibold))
                HStack(spacing: 6) {
                    Text(profile.role)
                    Text("·")
                    StatusDot(color: profile.status.tint, pulsing: profile.status == .working, size: 7)
                    Text(profile.status.label)
                        .foregroundStyle(profile.status == .idle ? .secondary : profile.status.tint)
                }
                .font(.subheadline)
                .foregroundStyle(.secondary)
                if profile.modelAvailable != false { Label(profile.model.detailedLabel, systemImage: "cpu")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.top, 1) }
                if let last = profile.lastActiveAt { Text("Last active \(last, style: .relative) ago").font(.caption) }
                if let action = profile.activitySummary, !action.isEmpty { Text(action).font(.caption) }
                if profile.isBotMode == true && profile.canonicalChatAvailable != true {
                    Text("Open this bot on the Studio to initialize its Bot Chat.").font(.caption)
                }
                Text(profile.summary)
                    .font(.subheadline)
                    .padding(.top, 4)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 6)
    }

    private func actions(_ profile: Profile) -> some View {
        HStack(spacing: 10) {
            Button {
                if profile.isBotMode == true {
                    environment.toasts.perform {
                        if let chat = try await environment.client.profiles.canonicalConversation(profileID: profile.id) {
                            conversations.apply(.conversationUpserted(chat))
                            router.open(.conversation(chat.id))
                        }
                    }
                } else { router.open(.newConversation(NewChatSeed(profileID: profile.id))) }
            } label: {
                Label("Chat", systemImage: "bubble.left.fill").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(!connection.supports(.sessions) || (profile.isBotMode == true && profile.canonicalChatAvailable != true))

            if profile.isBotMode != true && connection.supports(.kanban) {
                Button {
                    creatingTask = true
                } label: {
                    Label("Start Task", systemImage: "checklist").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .disabled(!connection.connection.isConnected)
            }
        }
        .controlSize(.large)
    }

    @ViewBuilder
    private func skillsSection(_ profile: Profile) -> some View {
        if !profile.skillIDs.isEmpty {
            Section("Skills") {
                ForEach(profile.skillIDs, id: \.self) { id in
                    if let skill = skills.value?.first(where: { $0.id == id }) {
                        NavigationLink(value: Route.skill(skill)) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(skill.name).font(.body.monospaced())
                                Text(skill.summary).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                    } else {
                        Text(id).font(.body.monospaced()).foregroundStyle(.secondary)
                    }
                }
            }
        }
    }
}

#Preview {
    NavigationStack { ProfileDetailView(profileID: MockID.caddy).routeDestinations() }
        .previewEnvironment()
}
